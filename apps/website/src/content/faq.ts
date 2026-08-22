/** Homepage and pricing FAQ. Keep answers aligned with current product behavior. */
export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: 'What is FramePilot?',
    a: 'FramePilot is a local-first desktop video editor with an AI agent built into the editing workflow. You can edit manually on a multitrack timeline or describe an edit and let the agent operate that same timeline through typed, validated operations. Agent runs remain inspectable and undoable.',
  },
  {
    q: 'Is FramePilot trying to replace Premiere Pro or DaVinci Resolve?',
    a: 'FramePilot is focused first on SaaS demos, screen recordings, product videos, talking-head content, and short-form edits. It already has a functional professional editing core, but the project does not present itself as a complete replacement for Premiere Pro, After Effects, or DaVinci Resolve.',
  },
  {
    q: 'What happens when the agent edits my project?',
    a: 'The model does not mutate your project file directly. It calls registered tools that produce typed timeline operations. Those operations are validated before they reach the project, become concrete timeline changes, and can be inspected and undone through the editor workflow.',
  },
  {
    q: 'Is my footage private?',
    a: 'FramePilot is local-first. Original media, project state, derived artifacts, and renders live on your machine. Optional hosted AI or media-intelligence capabilities are explicit and depend on the providers you configure.',
  },
  {
    q: 'How much does FramePilot cost?',
    a: 'The current paid plan is $25 per month or $199 per year, which works out to about $16.58 per month when billed annually. Both billing cadences get you the same editor features while the subscription is active.',
  },
  {
    q: 'How does the license work?',
    a: 'Checkout and licensing are handled by Freemius. After purchase you receive a license key, activate it in FramePilot, and can manage the subscription through the billing flow provided with your purchase.',
  },
  {
    q: 'Which platforms are supported?',
    a: 'FramePilot is distributed as a native desktop application with builds for macOS, Windows, and Linux. The download page points to the latest release assets.',
  },
  {
    q: 'Can I use it with external AI tools?',
    a: 'Yes. FramePilot includes an MCP server that exposes the same guarded editing surface to compatible MCP clients, so external agents can operate through typed tools instead of bypassing project authority.',
  },
  {
    q: 'Which AI providers can I use?',
    a: 'The current AI layer supports Anthropic, NVIDIA, OpenRouter, Groq, Google Gemini, Ollama, DeepSeek, and a deterministic mock provider for offline development and testing. Availability can vary by feature and provider capability.',
  },
  {
    q: 'Can I cancel, and is there a refund window?',
    a: 'You can cancel your subscription through the Freemius billing flow. The current purchase experience advertises a 14-day money-back guarantee.',
  },
];
