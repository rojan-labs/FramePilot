"""Export-friendly wrappers around the four SAM 2.1 video modules.

The wrappers reuse the upstream weights and reproduce upstream maths exactly, with two
deliberate, mathematically-identical rewrites:

1. **Real-valued RoPE.** Upstream ``apply_rotary_enc`` multiplies ``view_as_complex`` pairs by
   ``polar(1, θ)``. For a pair (a, b) that is (a·cosθ − b·sinθ, a·sinθ + b·cosθ); we compute
   exactly that with precomputed cos/sin tables, so no complex tensor reaches the exporter.
2. **Static memory shape.** Memory attention takes a fixed number of spatial memory slots
   (``MEM_SLOTS`` × 4096 tokens) and object-pointer tokens (``PTR_TOKENS``), padded, with a
   boolean key mask. Masked keys get zero attention weight, so the valid keys see the same
   softmax as the unpadded upstream call (up to float summation order). CoreML needs this:
   it is strict about dynamic dimensions.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import nn

#: Spatial memory slots (upstream num_maskmem = 7: 1 conditioning + 6 recent frames).
MEM_SLOTS = 7
#: Object-pointer tokens: up to 16 pointers (max_obj_ptrs_in_encoder), each split into 4.
PTR_TOKENS = 64
FEAT_TOKENS = 64 * 64
MEM_TOKENS = MEM_SLOTS * FEAT_TOKENS + PTR_TOKENS


def rope_tables(dim: int, end_x: int = 64, end_y: int = 64, theta: float = 10000.0):
    """cos/sin tables equal to angle(compute_axial_cis(dim, end_x, end_y, theta))."""
    freqs = 1.0 / (theta ** (torch.arange(0, dim, 4)[: (dim // 4)].float() / dim))
    t = torch.arange(end_x * end_y, dtype=torch.float32)
    t_x = (t % end_x).float()
    t_y = torch.div(t, end_x, rounding_mode="floor").float()
    ang = torch.cat([torch.outer(t_x, freqs), torch.outer(t_y, freqs)], dim=-1)  # (N, dim/2)
    return torch.cos(ang), torch.sin(ang)


def apply_rope_real(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    """x: (B, heads, N, D) with D even; cos/sin: (N, D/2). Interleaved pairs, like upstream."""
    a = x[..., 0::2]
    b = x[..., 1::2]
    out_a = a * cos - b * sin
    out_b = a * sin + b * cos
    return torch.stack((out_a, out_b), dim=-1).flatten(-2)


class RoPEAttentionReal(nn.Module):
    def __init__(self, attn: nn.Module) -> None:
        super().__init__()
        self.attn = attn
        head_dim = attn.internal_dim // attn.num_heads
        cos, sin = rope_tables(head_dim)
        self.register_buffer("cos", cos, persistent=False)
        self.register_buffer("sin", sin, persistent=False)

    def forward(self, q, k, v, num_k_rope: int, key_mask: torch.Tensor | None = None):
        a = self.attn
        q = a._separate_heads(a.q_proj(q), a.num_heads)
        k = a._separate_heads(a.k_proj(k), a.num_heads)
        v = a._separate_heads(a.v_proj(v), a.num_heads)
        q = apply_rope_real(q, self.cos, self.sin)
        if num_k_rope > 0:
            # Upstream repeats the (N, D/2) table r times along the key axis. Viewing the keys
            # as r blocks of N and broadcasting the table is the same arithmetic without
            # baking an r*N table into the graph as a constant.
            n = self.cos.shape[0]
            r = num_k_rope // n
            b, h, _, d = k.shape
            k_blocks = k[:, :, :num_k_rope].reshape(b, h, r, n, d)
            k_rot = apply_rope_real(k_blocks, self.cos, self.sin).reshape(b, h, num_k_rope, d)
            k = torch.cat([k_rot, k[:, :, num_k_rope:]], dim=2)
        out = F.scaled_dot_product_attention(q, k, v, attn_mask=key_mask)
        return a.out_proj(a._recombine_heads(out))


class MemoryAttentionExport(nn.Module):
    """(curr, curr_pos, memory, memory_pos, memory_valid) -> pix_feat_with_mem (tokens)."""

    def __init__(self, mem_attn: nn.Module) -> None:
        super().__init__()
        self.m = mem_attn
        self.self_attn = nn.ModuleList([RoPEAttentionReal(layer.self_attn) for layer in mem_attn.layers])
        self.cross_attn = nn.ModuleList([RoPEAttentionReal(layer.cross_attn_image) for layer in mem_attn.layers])

    def forward(self, curr, curr_pos, memory, memory_pos, memory_valid):
        # seq-first (N, 1, C) inputs, like upstream; memory_valid: (MEM_TOKENS,) bool
        m = self.m
        output = curr + 0.1 * curr_pos  # pos_enc_at_input
        output = output.transpose(0, 1)
        curr_pos = curr_pos.transpose(0, 1)
        memory = memory.transpose(0, 1)
        memory_pos = memory_pos.transpose(0, 1)
        key_mask = memory_valid.view(1, 1, 1, -1)
        num_k_rope = MEM_SLOTS * FEAT_TOKENS
        for i, layer in enumerate(m.layers):
            tgt2 = layer.norm1(output)
            output = output + self.self_attn[i](tgt2, tgt2, tgt2, num_k_rope=FEAT_TOKENS)
            tgt2 = layer.norm2(output)
            output = output + self.cross_attn[i](tgt2, memory + memory_pos, memory, num_k_rope, key_mask)
            tgt2 = layer.norm3(output)
            output = output + layer.linear2(layer.activation(layer.linear1(tgt2)))
        return m.norm(output).transpose(0, 1)


class ImageEncoderExport(nn.Module):
    """image (1,3,1024,1024) -> fpn0, fpn1, fpn2, pos0, pos1, pos2 (as forward_image)."""

    def __init__(self, sam) -> None:
        super().__init__()
        self.sam = sam

    def forward(self, image):
        out = self.sam.forward_image(image)
        f = out["backbone_fpn"]
        p = out["vision_pos_enc"]
        return f[0], f[1], f[2], p[0], p[1], p[2]


class DecoderExport(nn.Module):
    """Prompt encoder + mask decoder + object pointer, i.e. SAM2Base._forward_sam_heads.

    Inputs: pix_feat (1,256,64,64), high_res0 (1,32,256,256), high_res1 (1,64,128,128),
    point_coords (1,N,2) in 1024-pixel units, point_labels (1,N) int32.
    """

    def __init__(self, sam, multimask: bool) -> None:
        super().__init__()
        self.sam = sam
        self.multimask = multimask

    def forward(self, pix_feat, high_res0, high_res1, point_coords, point_labels):
        return self.sam._forward_sam_heads(
            backbone_features=pix_feat,
            point_inputs={"point_coords": point_coords, "point_labels": point_labels},
            mask_inputs=None,
            high_res_features=[high_res0, high_res1],
            multimask_output=self.multimask,
        )


class MemoryEncoderExport(nn.Module):
    """pix_feat (1,256,64,64), mask_for_mem (1,1,1024,1024; sigmoid/binarised, scaled+biased)."""

    def __init__(self, sam) -> None:
        super().__init__()
        self.enc = sam.memory_encoder

    def forward(self, pix_feat, mask_for_mem):
        out = self.enc(pix_feat, mask_for_mem, skip_mask_sigmoid=True)
        return out["vision_features"], out["vision_pos_enc"][0]


def pad_memory(memory: torch.Tensor, memory_pos: torch.Tensor, num_ptr_tokens: int):
    """Upstream layout [spatial k*4096][ptr p] -> static [k*4096][pad][ptr p][pad]."""
    total = memory.shape[0]
    spatial = total - num_ptr_tokens
    if spatial % FEAT_TOKENS != 0 or spatial > MEM_SLOTS * FEAT_TOKENS or num_ptr_tokens > PTR_TOKENS:
        raise ValueError(f"memory layout exceeds static capacity: spatial={spatial} ptr={num_ptr_tokens}")
    c = memory.shape[-1]
    mem = memory.new_zeros(MEM_TOKENS, 1, c)
    pos = memory_pos.new_zeros(MEM_TOKENS, 1, c)
    valid = torch.zeros(MEM_TOKENS, dtype=torch.bool)
    mem[:spatial] = memory[:spatial]
    pos[:spatial] = memory_pos[:spatial]
    valid[:spatial] = True
    base = MEM_SLOTS * FEAT_TOKENS
    mem[base : base + num_ptr_tokens] = memory[spatial:]
    pos[base : base + num_ptr_tokens] = memory_pos[spatial:]
    valid[base : base + num_ptr_tokens] = True
    return mem, pos, valid


def sanity_rope() -> float:
    """Max |real RoPE - complex RoPE| on random data (should be ~1e-6)."""
    from sam2.modeling.position_encoding import apply_rotary_enc, compute_axial_cis

    x = torch.randn(1, 1, 4096, 256)
    k = torch.randn(1, 1, 3 * 4096, 256)
    cis = compute_axial_cis(dim=256, end_x=64, end_y=64)
    q_ref, k_ref = apply_rotary_enc(x, k, cis, repeat_freqs_k=True)
    cos, sin = rope_tables(256)
    q_new = apply_rope_real(x, cos, sin)
    k_new = apply_rope_real(k, cos.repeat(3, 1), sin.repeat(3, 1))
    return max(float((q_ref - q_new).abs().max()), float((k_ref - k_new).abs().max()))

