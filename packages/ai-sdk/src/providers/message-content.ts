/**
 * @framepilot/ai-sdk/providers/message-content — turning an {@link AiMessage} into each
 * wire format's message content, text-only or multimodal.
 *
 * WHY it is shared: every provider in this SDK speaks one of exactly two content shapes —
 * Anthropic's `{type:'image', source:{...}}` blocks or the OpenAI-compatible
 * `{type:'image_url', image_url:{url}}` blocks — and both degrade to a plain string when a
 * message carries no images. Writing that per provider is how one of them ends up sending
 * an array where the endpoint wanted a string (which most reject outright) or silently
 * dropping the image on a model that would have read it.
 *
 * The degrade rule is the important one: `content` ALWAYS carries the text, and the text
 * always says what the images show. A provider or model without vision therefore answers
 * from the description rather than failing, which is the difference between a weaker
 * answer and a broken run.
 */
import type { AiImage, AiMessage } from './types.js';

/** An Anthropic content block (text or image). */
type AnthropicBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly source: {
        readonly type: 'base64';
        readonly media_type: string;
        readonly data: string;
      };
    };

/** An OpenAI-compatible content part (text or image URL). */
type OpenAiPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

/** Images this message should actually send, or `undefined` when there are none. */
function sendableImages(message: AiMessage): readonly AiImage[] | undefined {
  // A system message never carries images (no provider here accepts them there), and an
  // empty array must not turn a string body into a one-element array for nothing.
  if (message.role === 'system') return undefined;
  const images = message.images;
  return images !== undefined && images.length > 0 ? images : undefined;
}

/**
 * Anthropic Messages API content for one message.
 *
 * @returns The plain string when there are no images (the shape the API has always
 *   taken), or a block array with the text first and each image after it.
 */
export function anthropicContent(message: AiMessage): string | readonly AnthropicBlock[] {
  const images = sendableImages(message);
  if (!images) return message.content;
  return [
    { type: 'text', text: message.content },
    ...images.map(
      (image): AnthropicBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
      }),
    ),
  ];
}

/**
 * OpenAI-compatible chat content for one message. Images ride as `data:` URIs — see
 * {@link AiImage} for why the bytes travel inline rather than as a hosted URL.
 */
export function openAiContent(message: AiMessage): string | readonly OpenAiPart[] {
  const images = sendableImages(message);
  if (!images) return message.content;
  return [
    { type: 'text', text: message.content },
    ...images.map(
      (image): OpenAiPart => ({
        type: 'image_url',
        image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
      }),
    ),
  ];
}

/** A Google `generateContent` part (text or inline image data). */
type GooglePart =
  | { readonly text: string }
  | { readonly inlineData: { readonly mimeType: string; readonly data: string } };

/** Google `generateContent` parts for one message. Always an array — Google has no
 *  string shorthand, so the text-only case is simply a one-element parts list. */
export function googleParts(message: AiMessage): readonly GooglePart[] {
  const images = sendableImages(message);
  const text: GooglePart = { text: message.content };
  if (!images) return [text];
  return [
    text,
    ...images.map(
      (image): GooglePart => ({
        inlineData: { mimeType: image.mediaType, data: image.base64 },
      }),
    ),
  ];
}
