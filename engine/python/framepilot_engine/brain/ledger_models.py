"""The shot ledger — what the agent knows about a picture without looking at it.

WHY (ADR 0175, ``plan/visual-understanding``): the agent has never called
``get_frame`` in any recorded run, and never will while looking costs a turn. So
perception is compiled ONCE per asset at import and read as text on every turn.
This module is the shape of that compilation: one record per **shot**, split by
where each fact came from, plus a per-asset digest.

Three groups, three provenances, three failure modes — kept apart on purpose:

``measured``
    ffmpeg only. Exact, keyless, offline, always available (ffmpeg is a hard
    dependency). This is the floor under every backend including TwelveLabs.
``labelled``
    A local embedding/face pack (ADR 0114). Probabilistic: every field carries
    its own confidence and the renderer drops anything under threshold.
``described``
    A local VLM pack or the hosted captioner. Also probabilistic, and the only
    group that can be wrong in an interesting way, which is why the deterministic
    groups are never derived from it.

A group that could not be produced is ``None`` — "not measured yet" — and is
never faked as a default. Coverage is reported per tier so the agent can read
"described 12/61" as a fact rather than mistaking absence for emptiness.

Times are **asset seconds** throughout. Timeline seconds are a projection through
whichever clip references the asset and are never stored (the same rule the
evidence packets follow).

Kept byte-identical, by hand, to the Zod mirror in
``packages/ai-sdk/src/ledger.ts``; both sides have a drift test.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field

# ── Versions ────────────────────────────────────────────────────────────────────────
#
# Each tier's version is stored on its row. Bumping one nulls THAT column and re-queues
# THAT tier — a model swap must never cost a re-measure of the other two. Bump when the
# meaning of a field changes, not when a threshold moves in the renderer.

TIER0_VERSION = 1
TIER1_VERSION = 1
TIER2_VERSION = 1


class MotionClass(StrEnum):
    """How much the frame moves, from the SI/TI medians over the shot."""

    STATIC = "static"
    SLOW = "slow"
    HANDHELD = "handheld"
    FAST = "fast"


class ShotSize(StrEnum):
    """The framing ladder, coarse to close. Ordered; the gap between two values is a
    "step", which is what a cut-pair delta counts."""

    EWS = "EWS"
    WS = "WS"
    MWS = "MWS"
    MS = "MS"
    MCU = "MCU"
    CU = "CU"
    ECU = "ECU"


#: Ladder order for step arithmetic (EWS=0 … ECU=6). One place, so a cut delta and a
#: policy table can never disagree about which direction "wider" is.
SHOT_SIZE_LADDER: tuple[ShotSize, ...] = (
    ShotSize.EWS,
    ShotSize.WS,
    ShotSize.MWS,
    ShotSize.MS,
    ShotSize.MCU,
    ShotSize.CU,
    ShotSize.ECU,
)


class SubjectKind(StrEnum):
    """What the shot is OF — the coarse question a cutaway decision turns on."""

    PERSON = "person"
    PEOPLE = "people"
    OBJECT = "object"
    PLACE = "place"
    SCREEN = "screen"
    TEXT = "text"
    ANIMAL = "animal"
    FOOD = "food"
    VEHICLE = "vehicle"
    NONE = "none"


class ScreenContent(StrEnum):
    """What kind of material this is, editorially."""

    TALKING_HEAD = "talking-head"
    B_ROLL = "b-roll"
    SCREEN_RECORDING = "screen-recording"
    SLIDES = "slides"
    TITLE_CARD = "title-card"
    GRAPHIC = "graphic"


class CameraMovement(StrEnum):
    STATIC = "static"
    PAN = "pan"
    TILT = "tilt"
    ZOOM = "zoom"
    HANDHELD = "handheld"
    TRACKING = "tracking"


class LumaStats(BaseModel):
    """Brightness distribution over the shot, normalised 0..1 from the Y plane.

    ``p10``/``p90`` are signalstats' own ``YLOW``/``YHIGH`` — named for what they actually
    are. Percentiles rather than min/max: a single blown highlight or a black border must
    not decide that a shot is bright, and they are also what the contrast index and the
    shadow/highlight half of a colour match are computed from.
    """

    mean: float
    std: float
    p10: float
    p90: float


class ChromaStats(BaseModel):
    """Colour distribution over the shot, from ``signalstats`` U/V means."""

    u_mean: float = Field(alias="uMean", description="8-bit U mean (blue difference).")
    v_mean: float = Field(alias="vMean", description="8-bit V mean (red difference).")
    sat_mean: float = Field(alias="satMean", description="Saturation mean, normalised 0..1.")

    model_config = {"populate_by_name": True}


class MotionStats(BaseModel):
    """Spatial and temporal information (``siti``) plus the class derived from them."""

    si: float = Field(description="Spatial information median — detail, not movement.")
    ti: float = Field(description="Temporal information median — frame-to-frame movement.")
    motion_class: MotionClass = Field(alias="class")

    model_config = {"populate_by_name": True}


class MeasuredFacts(BaseModel):
    """Tier 0: what ffmpeg can prove about a shot. No key, no model, no network."""

    tier0_version: int = Field(alias="tier0Version")
    luma: LumaStats
    chroma: ChromaStats
    warmth: float = Field(
        description="(V minus U) normalised to -1..1 and calibrated so a neutral chart reads 0. "
        "Positive is warm. This is what a white-balance delta at a cut is measured in.",
    )
    contrast_idx: float = Field(
        alias="contrastIdx",
        description="p90 - p10 of luma: 'flat' vs 'punchy' as one printable number.",
    )
    motion: MotionStats
    cut_score: float = Field(
        alias="cutScore",
        description="scdet score at the shot's start — how hard it begins.",
    )
    black: bool = Field(description="The shot lies inside a blackdetect interval.")
    freeze: bool = Field(description="The shot lies inside a freezedetect interval.")
    sharpness: float = Field(description="1 - normalised blurdetect median; low is soft.")
    phash: str | None = Field(
        default=None,
        description="64-bit dHash of the keyframe as TEXT — a value JSON numbers cannot hold. "
        "None when no keyframe hash was computed: the hash comes from the sampler's JPEG "
        "pass, not the statistics decode, so a shot can legitimately have every other "
        "measured fact and no hash. It must never be a placeholder string — every "
        "unhashed shot would then be a duplicate of every other.",
    )
    loudness_lufs: float | None = Field(
        default=None,
        alias="loudnessLufs",
        description="Integrated loudness over the shot; None when the asset has no audio.",
    )

    model_config = {"populate_by_name": True}


class Confident(BaseModel):
    """A label and how much the model believed it.

    Every probabilistic field is wrapped rather than bare, because the printing rule
    ("show it only at p ≥ 0.6") has to be applied uniformly and a bare string cannot
    carry the number the rule reads.
    """

    value: str
    p: float = Field(ge=0.0, le=1.0)


class EntityRef(BaseModel):
    """A stable identity seen in this shot — a person cluster, or a place cluster."""

    id: str = Field(description="Stable cluster id, e.g. person_03.")
    kind: str = Field(description="person | setting")
    p: float = Field(ge=0.0, le=1.0)


class LabelledFacts(BaseModel):
    """Tier 1: what a local embedding/face pack recognises. Probabilistic throughout."""

    tier1_version: int = Field(alias="tier1Version")
    model: str = Field(description="Producing model id; two spaces never mix.")
    shot_size: Confident | None = Field(default=None, alias="shotSize")
    subject_kind: Confident | None = Field(default=None, alias="subjectKind")
    setting: Confident | None = None
    screen_content: Confident | None = Field(default=None, alias="screenContent")
    faces: int = 0
    entities: list[EntityRef] = Field(default_factory=list)
    duplicate_of: str | None = Field(
        default=None,
        alias="duplicateOf",
        description="Shot key of a near-identical shot (phash Hamming ≤ 6) — a repeated take.",
    )

    model_config = {"populate_by_name": True}


class CameraFacts(BaseModel):
    shot_size: ShotSize | None = Field(default=None, alias="shotSize")
    angle: str | None = None
    movement: CameraMovement | None = None

    model_config = {"populate_by_name": True}


class DescribedFacts(BaseModel):
    """Tier 2: one structured caption per shot.

    Structured, not prose: ``summary`` is what FTS indexes and a human reads, and every
    other field is what a filter or a solver can actually use. The hosted captioner and
    the local VLM pack emit this same object — one schema, three producers.
    """

    tier2_version: int = Field(alias="tier2Version")
    model: str
    summary: str = Field(description="≤2 sentences, only what is visible.")
    subject: str = ""
    action: str = ""
    setting: str = ""
    camera: CameraFacts = Field(default_factory=CameraFacts)
    mood: str = ""
    on_screen_text: list[str] = Field(
        default_factory=list,
        alias="onScreenText",
        description="Verbatim text visible in frame; never paraphrased.",
    )
    quality: list[str] = Field(default_factory=list, description="Closed vocabulary.")
    p: float = Field(default=0.7, ge=0.0, le=1.0)

    model_config = {"populate_by_name": True}


class ShotRecord(BaseModel):
    """One shot of one asset, with whichever tiers have run.

    The primary key is ``(asset_id, content_hash, shot_index)``: changed bytes are a
    different asset as far as the ledger is concerned, which is what makes re-import free
    and a re-encode correctly expensive.
    """

    asset_id: str = Field(alias="assetId")
    content_hash: str = Field(alias="contentHash")
    shot_index: int = Field(alias="shotIndex")
    t0: float = Field(description="Shot start, ASSET seconds (inclusive).")
    t1: float = Field(description="Shot end, ASSET seconds (exclusive).")
    keyframe_t: float = Field(alias="keyframeT")
    split_of: bool = Field(
        default=False,
        alias="splitOf",
        description="A duration split inside one continuous take, not a scene cut. Long "
        "static material (interviews, screen recordings) is cut every 30s so per-shot "
        "statistics stay local; a policy must not read this as an edit point.",
    )
    measured: MeasuredFacts | None = None
    labelled: LabelledFacts | None = None
    described: DescribedFacts | None = None

    model_config = {"populate_by_name": True}


class TierCoverage(BaseModel):
    """How much of a project each tier has actually covered.

    Reported rather than inferred: a project with no `described` rows is one that has not
    been described yet, and the agent must be able to tell that from footage that has
    nothing to say.
    """

    measured: int = 0
    labelled: int = 0
    described: int = 0
    total: int = 0


class AssetDigest(BaseModel):
    """The whole-asset summary the project digest is built from.

    Deliberately small and pre-aggregated: the context block that tells the agent "14
    assets, 212 shots, three of them dim, the host is in 86" must never load per-shot rows.
    """

    asset_id: str = Field(alias="assetId")
    content_hash: str = Field(alias="contentHash")
    duration_s: float = Field(alias="durationS")
    shot_count: int = Field(alias="shotCount")
    median_shot_s: float = Field(alias="medianShotS")
    shot_size_mix: dict[str, float] = Field(default_factory=dict, alias="shotSizeMix")
    setting_mix: dict[str, float] = Field(default_factory=dict, alias="settingMix")
    motion_mix: dict[str, float] = Field(default_factory=dict, alias="motionMix")
    people: list[str] = Field(default_factory=list, description="Entity ids, most frequent first.")
    exposure_range: tuple[float, float] | None = Field(default=None, alias="exposureRange")
    warmth_range: tuple[float, float] | None = Field(default=None, alias="warmthRange")
    has_speech: bool = Field(default=False, alias="hasSpeech")
    low_quality_shots: list[int] = Field(
        default_factory=list,
        alias="lowQualityShots",
        description="Shot indices flagged soft, black or frozen.",
    )
    coverage: TierCoverage = Field(default_factory=TierCoverage)

    model_config = {"populate_by_name": True}


class LedgerSnapshot(BaseModel):
    """What one run reads: the shots of the assets its timeline references, plus digests.

    Bounded and paged by the route. A run never loads the library — only the assets that
    are actually on the timeline it is editing.
    """

    shots: list[ShotRecord] = Field(default_factory=list)
    digests: list[AssetDigest] = Field(default_factory=list)
    coverage: TierCoverage = Field(default_factory=TierCoverage)
    next_cursor: str | None = Field(default=None, alias="nextCursor")

    model_config = {"populate_by_name": True}
