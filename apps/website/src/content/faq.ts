/** Homepage and pricing FAQ. Keep answers aligned with current product behavior. */
export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: 'What is FramePilot?',
    a: 'A desktop video editor that runs on your own machine, with an AI agent wired into the timeline instead of bolted on beside it. Cut by hand on a multitrack timeline, or describe the change you want and let the agent make it. Either way you end up with real timeline edits you can open up and undo.',
  },
  {
    q: 'Is FramePilot trying to replace Premiere Pro or DaVinci Resolve?',
    a: "No. It's built for SaaS demos, screen recordings, product videos, talking-head content, and short-form edits. The editing core underneath is a real one, but if you're grading a feature film or compositing in After Effects, this isn't the tool yet.",
  },
  {
    q: 'What happens when the agent edits my project?',
    a: "The model never writes to your project file. It calls tools that emit typed timeline operations, and those get validated before anything reaches the project. What lands on your timeline is the same kind of edit you'd have made by hand, which is exactly why undo works on it.",
  },
  {
    q: 'Is my footage private?',
    a: 'Your footage, projects, and renders stay on your machine. Some AI features can call a hosted provider, but only one you configure yourself, and you pick which. Nothing gets uploaded quietly in the background.',
  },
  {
    q: 'How much does FramePilot cost?',
    a: '$25 a month, or $199 a year, which works out to about $16.58 a month. Both get you the same editor for as long as the subscription is active.',
  },
  {
    q: 'How does the license work?',
    a: 'Freemius handles checkout and licensing. You get a license key after buying, activate it inside FramePilot, and manage the subscription through the billing flow that came with your purchase.',
  },
  {
    q: 'Which platforms are supported?',
    a: 'It ships as a native desktop app for macOS, Windows, and Linux. The download page always points at the newest release.',
  },
  {
    q: 'Can I use it with external AI tools?',
    a: 'Yes. FramePilot runs an MCP server that hands the same guarded editing tools to any compatible MCP client, so an outside agent works through typed operations rather than around them.',
  },
  {
    q: 'Which AI providers can I use?',
    a: 'Anthropic, NVIDIA, OpenRouter, Groq, Google Gemini, Ollama, DeepSeek, and a deterministic mock provider for working offline. Which features you get depends on what the provider you choose can actually do.',
  },
  {
    q: 'Can I cancel, and is there a refund window?',
    a: 'Cancel whenever you like through the Freemius billing flow. Checkout currently comes with a 14-day money-back guarantee.',
  },
];
