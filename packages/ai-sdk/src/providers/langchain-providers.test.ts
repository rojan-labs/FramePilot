/**
 * Concrete LangChain adapter contracts plus lazy factory wiring.
 *
 * The exported roster wrappers deliberately own no provider SDK now. Tests that inspect
 * protected model construction target the concrete provider modules, while factory tests
 * pin the lightweight wrappers and synchronous model-id contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LANGCHAIN_PROVIDERS,
  LangChainDeepSeekProvider,
  LangChainGoogleProvider,
  LangChainGroqProvider,
  LangChainNvidiaProvider,
  LangChainOllamaProvider,
  LangChainOpenAiCompatibleProvider,
  LangChainOpenRouterProvider,
  LangChainVercelGatewayProvider,
} from './langchain-providers.js';
import { ConcreteLangChainDeepSeekProvider } from './langchain-deepseek.js';
import { ConcreteLangChainGoogleProvider } from './langchain-google.js';
import { ConcreteLangChainGroqProvider } from './langchain-groq.js';
import { ConcreteLangChainOllamaProvider } from './langchain-ollama.js';
import {
  ConcreteLangChainNvidiaProvider,
  ConcreteLangChainOpenAiCompatibleProvider,
  ConcreteLangChainOpenRouterProvider,
  ConcreteLangChainVercelGatewayProvider,
} from './langchain-openai-compatible.js';
import {
  LangChainChatProvider,
  SHARED_CHAT_OPTIONS,
  assertSingleRetryAuthority,
} from './langchain-chat.js';
import { withResilience } from './resilient-provider.js';
import { ProviderError } from '../reliability/types.js';
import { LANGCHAIN_SERVABLE, createProvider } from './index.js';
import {
  PROVIDER_NAMES,
  type AiCompletionRequest,
  type ProviderChunk,
  type ProviderConfig,
  type ProviderName,
} from './types.js';

const request: AiCompletionRequest = {
  messages: [
    { role: 'system', content: 'contract' },
    { role: 'user', content: 'tighten the intro' },
  ],
};

interface Internals {
  buildModel(request: AiCompletionRequest, streaming: boolean): { lc_kwargs?: unknown };
  buildMessages(request: AiCompletionRequest): { getType(): string }[];
}

const CONCRETE_ROSTER = [
  ['groq', ConcreteLangChainGroqProvider],
  ['google', ConcreteLangChainGoogleProvider],
  ['ollama', ConcreteLangChainOllamaProvider],
  ['deepseek', ConcreteLangChainDeepSeekProvider],
  ['openrouter', ConcreteLangChainOpenRouterProvider],
  ['vercel-gateway', ConcreteLangChainVercelGatewayProvider],
  ['nvidia', ConcreteLangChainNvidiaProvider],
  ['openai-compatible', ConcreteLangChainOpenAiCompatibleProvider],
] as const;

const LAZY_ROSTER = [
  ['groq', LangChainGroqProvider],
  ['google', LangChainGoogleProvider],
  ['ollama', LangChainOllamaProvider],
  ['deepseek', LangChainDeepSeekProvider],
  ['openrouter', LangChainOpenRouterProvider],
  ['vercel-gateway', LangChainVercelGatewayProvider],
  ['nvidia', LangChainNvidiaProvider],
  ['openai-compatible', LangChainOpenAiCompatibleProvider],
] as const;

/**
 * A usable config for one provider. `openai-compatible` has no default endpoint by
 * design, so the shared-contract cases below must supply one or they would be asserting
 * the missing-URL error instead of the contract under test.
 */
const configFor = (name: ProviderName): ProviderConfig =>
  ({
    name,
    apiKey: 'k',
    ...(name === 'openai-compatible' ? { baseUrl: 'http://127.0.0.1:8317/v1' } : {}),
  }) as ProviderConfig;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('concrete LangChain provider adapters', () => {
  it.each(CONCRETE_ROSTER)(
    '%s constructs a model with LangChain retries disabled',
    (name, Adapter) => {
      const provider = new Adapter(configFor(name));
      const model = (provider as unknown as Internals).buildModel(request, false);
      const kwargs = model.lc_kwargs as { maxRetries?: number; streamUsage?: boolean };
      expect(kwargs.maxRetries).toBe(0);
      expect(kwargs.streamUsage).toBe(true);
      expect(provider.name).toBe(name);
    },
  );

  it.each(CONCRETE_ROSTER)(
    '%s shapes system/user messages without dropping either',
    (name, Adapter) => {
      const provider = new Adapter(configFor(name));
      const messages = (provider as unknown as Internals).buildMessages(request);
      expect(messages.map((message) => message.getType())).toEqual(['system', 'human']);
    },
  );

  it.each(CONCRETE_ROSTER)(
    '%s forwards temperature when the request sets it and omits it otherwise',
    (name, Adapter) => {
      const provider = new Adapter(configFor(name));
      const configured = (provider as unknown as Internals).buildModel(
        { ...request, temperature: 0.3, maxTokens: 1234 },
        false,
      ).lc_kwargs as Record<string, unknown>;
      expect(configured.temperature).toBe(0.3);
      const defaults = (provider as unknown as Internals).buildModel(request, false)
        .lc_kwargs as Record<string, unknown>;
      expect(defaults).not.toHaveProperty('temperature');
    },
  );

  /**
   * The prototype that owns the INHERITED `complete` — i.e. the base implementation
   * the openai-compatible adapter delegates to via `super`. Walking the chain and
   * skipping the adapter's own override is what makes the retry observable: spying
   * on the nearest prototype would replace the override under test instead.
   */
  function baseCompleteOwner(provider: object): { complete: unknown } {
    let proto = Object.getPrototypeOf(provider) as object | null;
    let seenOverride = false;
    while (proto !== null) {
      if (Object.prototype.hasOwnProperty.call(proto, 'complete')) {
        if (seenOverride) return proto as { complete: unknown };
        seenOverride = true;
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    throw new Error('No inherited complete() found on the provider prototype chain.');
  }

  it('signals a retryable ProviderError for a rejected temperature, and remembers not to send it again', async () => {
    // "OpenAI-compatible" is a wire format, not a promise about which parameters a
    // model takes: a reasoning model behind a local gateway answers `Unsupported
    // parameter: temperature` and fails the call outright. Sending it to everyone
    // broke those endpoints completely; sending it to nobody silently ignored the
    // temperature everywhere else. The endpoint is asked once and remembered.
    //
    // The provider itself does not retry any more — `resilient-provider.ts` is the
    // single retry authority (§5.1, `langchain-chat.ts`), so this only hands it a
    // retryable error and remembers the endpoint's answer for next time.
    const provider = new ConcreteLangChainOpenAiCompatibleProvider(configFor('openai-compatible'));
    const internals = provider as unknown as Internals;
    const hot = { ...request, temperature: 0.3 };

    expect(
      (internals.buildModel(hot, false).lc_kwargs as Record<string, unknown>).temperature,
    ).toBe(0.3);

    let calls = 0;
    const superComplete = vi
      .spyOn(baseCompleteOwner(provider), 'complete')
      .mockImplementation(async function (this: unknown) {
        calls += 1;
        if (calls === 1) throw new Error('400 Unsupported parameter: temperature');
        return { text: 'ok' } as never;
      });

    const rejection: unknown = await provider.complete(hot).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ProviderError);
    expect((rejection as ProviderError).retryable).toBe(true);
    expect(calls).toBe(1);

    // Remembered: the parameter is gone from every later request, without a
    // second failed round trip — this is what makes the retry `ResilientProvider`
    // drives (see the `ResilientProvider` integration test below) succeed.
    expect(
      (internals.buildModel(hot, false).lc_kwargs as Record<string, unknown>).temperature,
    ).toBeUndefined();
    await expect(provider.complete(hot)).resolves.toMatchObject({ text: 'ok' });
    expect(calls).toBe(2);
    superComplete.mockRestore();
  });

  it('retries a rejected temperature through ResilientProvider, not internally', async () => {
    // Regression: the retry used to be a second call made from inside `complete()`,
    // invisible to `ResilientProvider`'s own retry-count telemetry and racing the
    // combined two-request latency against a connect-timeout budget sized for one.
    // Driving it through `ResilientProvider` for real closes both gaps.
    const provider = new ConcreteLangChainOpenAiCompatibleProvider(configFor('openai-compatible'));
    const hot = { ...request, temperature: 0.3 };

    let calls = 0;
    const superComplete = vi
      .spyOn(baseCompleteOwner(provider), 'complete')
      .mockImplementation(async function (this: unknown) {
        calls += 1;
        if (calls === 1) throw new Error('400 Unsupported parameter: temperature');
        return { text: 'ok' } as never;
      });

    const onRetry = vi.fn();
    const resilient = withResilience(provider, {
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      hooks: { onRetry },
    });

    await expect(resilient.complete(hot)).resolves.toMatchObject({ text: 'ok' });
    expect(calls).toBe(2);
    // The retry is now visible to the single retry authority's own telemetry —
    // the whole point of not retrying internally.
    expect(onRetry).toHaveBeenCalledTimes(1);
    superComplete.mockRestore();
  });

  it('signals a retryable ProviderError for a rejected temperature in stream(), before any chunk', async () => {
    const provider = new ConcreteLangChainOpenAiCompatibleProvider(configFor('openai-compatible'));
    const hot = { ...request, temperature: 0.3 };

    function rejecting(): AsyncIterable<ProviderChunk> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('400 Unsupported parameter: temperature')),
        }),
      };
    }
    const streamSpy = vi
      .spyOn(LangChainChatProvider.prototype, 'stream')
      .mockReturnValue(rejecting());

    const rejection: unknown = await (async () => {
      try {
        for await (const _chunk of provider.stream!(hot)) {
          /* never reached */
        }
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(rejection).toBeInstanceOf(ProviderError);
    expect((rejection as ProviderError).retryable).toBe(true);
    streamSpy.mockRestore();
  });

  it('never swallows an unrelated provider failure as a temperature problem', async () => {
    const provider = new ConcreteLangChainOpenAiCompatibleProvider(configFor('openai-compatible'));
    const superComplete = vi
      .spyOn(baseCompleteOwner(provider), 'complete')
      .mockRejectedValue(new Error('429 rate limited'));
    await expect(provider.complete({ ...request, temperature: 0.3 })).rejects.toThrow(
      /rate limited/,
    );
    superComplete.mockRestore();
  });

  it.each(['groq', 'deepseek', 'openrouter', 'vercel-gateway', 'nvidia'] as const)(
    '%s honours a host-configured base URL over its default',
    (name) => {
      const Adapter = {
        groq: ConcreteLangChainGroqProvider,
        deepseek: ConcreteLangChainDeepSeekProvider,
        openrouter: ConcreteLangChainOpenRouterProvider,
        'vercel-gateway': ConcreteLangChainVercelGatewayProvider,
        nvidia: ConcreteLangChainNvidiaProvider,
      }[name];
      const provider = new Adapter({
        name,
        apiKey: 'k',
        baseUrl: 'http://custom:9',
      } as ProviderConfig);
      expect(() => (provider as unknown as Internals).buildModel(request, false)).not.toThrow();
    },
  );

  it('routes Ollama to the server root, not the OpenAI-compatible /v1 surface', () => {
    const provider = new ConcreteLangChainOllamaProvider({
      name: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
    } as ProviderConfig);
    const model = (provider as unknown as Internals).buildModel(request, false) as {
      baseUrl?: string;
    };
    expect(model.baseUrl).toBe('http://localhost:11434');
  });

  it('passes a configured base URL to Gemini, and omits it otherwise', () => {
    const withUrl = new ConcreteLangChainGoogleProvider({
      name: 'google',
      apiKey: 'k',
      baseUrl: 'http://custom:9',
    } as ProviderConfig);
    const kwargs = (withUrl as unknown as Internals).buildModel(request, false).lc_kwargs as Record<
      string,
      unknown
    >;
    expect(kwargs.baseUrl).toBe('http://custom:9');

    const without = new ConcreteLangChainGoogleProvider({
      name: 'google',
      apiKey: 'k',
    } as ProviderConfig);
    expect(
      (
        (without as unknown as Internals).buildModel(request, false).lc_kwargs as Record<
          string,
          unknown
        >
      ).baseUrl,
    ).toBeUndefined();
  });

  it('uses Ollama’s default endpoint when the host configured none', () => {
    const provider = new ConcreteLangChainOllamaProvider({ name: 'ollama' } as ProviderConfig);
    const model = (provider as unknown as Internals).buildModel(request, false) as {
      baseUrl?: string;
    };
    expect(model.baseUrl).toBe('http://localhost:11434');
  });

  it('sends a configured key to Ollama as an Authorization header', () => {
    // ChatOllama has no apiKey option, so a key can only reach an authenticating proxy
    // in front of Ollama this way. Dropping it (the shape before this test) left such a
    // server unreachable with no error naming the cause.
    const provider = new ConcreteLangChainOllamaProvider({
      name: 'ollama',
      apiKey: 'secret',
    } as ProviderConfig);
    // Asserted on the constructor fields: ChatOllama forwards `headers` into the Ollama
    // client it builds and keeps no copy of its own.
    const kwargs = (provider as unknown as Internals).buildModel(request, false).lc_kwargs as {
      headers?: Record<string, string>;
    };
    expect(kwargs.headers?.Authorization).toBe('Bearer secret');
  });

  it('omits the Ollama Authorization header when no key is configured', () => {
    const provider = new ConcreteLangChainOllamaProvider({ name: 'ollama' } as ProviderConfig);
    const kwargs = (provider as unknown as Internals).buildModel(request, false).lc_kwargs as {
      headers?: Record<string, string>;
    };
    expect(kwargs.headers).toBeUndefined();
  });

  it('sends the OpenAI-compatible provider to the configured server, key and all', () => {
    const provider = new ConcreteLangChainOpenAiCompatibleProvider({
      name: 'openai-compatible',
      apiKey: 'proxy-key',
      baseUrl: 'http://127.0.0.1:8317/v1',
      model: 'claude-sonnet-4-6',
    } as ProviderConfig);
    const kwargs = (provider as unknown as Internals).buildModel(request, false)
      .lc_kwargs as Record<string, unknown>;
    expect((kwargs.configuration as { baseURL?: string }).baseURL).toBe('http://127.0.0.1:8317/v1');
    expect(kwargs.apiKey).toBe('proxy-key');
    expect(provider.modelId).toBe('claude-sonnet-4-6');
  });

  it('keeps a keyless OpenAI-compatible server reachable', () => {
    // The OpenAI client refuses to construct without a key; a local gateway usually
    // wants none. The placeholder exists only to get past that check.
    const provider = new ConcreteLangChainOpenAiCompatibleProvider({
      name: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
    } as ProviderConfig);
    const kwargs = (provider as unknown as Internals).buildModel(request, false)
      .lc_kwargs as Record<string, unknown>;
    expect(kwargs.apiKey).toBe('not-needed');
  });

  it.each([undefined, '', '   '])(
    'fails the OpenAI-compatible provider permanently when its URL is %p',
    (baseUrl) => {
      const provider = new ConcreteLangChainOpenAiCompatibleProvider({
        name: 'openai-compatible',
        ...(baseUrl === undefined ? {} : { baseUrl }),
      } as ProviderConfig);
      let thrown: unknown;
      try {
        (provider as unknown as Internals).buildModel(request, false);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderError);
      // Non-retryable on purpose: retrying a missing setting three times only delays
      // the message that tells the user what to fill in.
      expect((thrown as ProviderError).retryable).toBe(false);
      expect((thrown as ProviderError).message).toMatch(/no server URL configured/);
    },
  );

  it('never silently borrows another service’s endpoint', () => {
    // The whole point of the provider: with no URL it must fail, not call someone else.
    const provider = new ConcreteLangChainOpenAiCompatibleProvider({
      name: 'openai-compatible',
    } as ProviderConfig);
    expect(() => (provider as unknown as Internals).buildModel(request, false)).toThrow();
  });

  it('refuses a model that would retry on its own', () => {
    expect(() => assertSingleRetryAuthority({ maxRetries: 2 })).toThrow(/single retry authority/);
    expect(() => assertSingleRetryAuthority({})).toThrow(/single retry authority/);
    expect(() => assertSingleRetryAuthority(SHARED_CHAT_OPTIONS)).not.toThrow();
  });

  it('asks for streamed usage', () => {
    expect(SHARED_CHAT_OPTIONS.streamUsage).toBe(true);
  });
});

describe('lazy LangChain provider roster', () => {
  it.each(LAZY_ROSTER)('%s reports its model id before any concrete SDK call', (name, Adapter) => {
    const provider = new Adapter(configFor(name));
    expect(typeof provider.modelId).toBe('string');
    expect(provider.modelId.length).toBeGreaterThan(0);
    const overridden = new Adapter({ ...configFor(name), model: 'custom-x' } as ProviderConfig);
    expect(overridden.modelId).toBe('custom-x');
  });

  const servable = LANGCHAIN_SERVABLE.filter((name) => name !== 'anthropic');

  it('exposes exactly the roster the factory can serve', () => {
    expect([...servable].sort()).toEqual(Object.keys(LANGCHAIN_PROVIDERS).sort());
  });

  it.each(LANGCHAIN_SERVABLE)('serves %s through the lazy LangChain path', (name) => {
    const provider = createProvider(name as ProviderName);
    expect(provider.name).toBe(name);
    expect(provider.modelId).toBe(createProvider(name as ProviderName).modelId);
  });

  it('serves every real provider through LangChain, leaving only mock native', () => {
    const unserved = PROVIDER_NAMES.filter((name) => !LANGCHAIN_SERVABLE.includes(name));
    expect(unserved).toEqual(['mock']);
  });

  it('leaves the mock provider alone', () => {
    expect(createProvider('mock').name).toBe('mock');
  });
});

describe('a stream the provider cut short', () => {
  it('flags the done chunk when the last chunk says it ran out of room', async () => {
    // The orchestrator retries this rather than publishing the fragment — see
    // `unusableTurnReason`. Only the LAST chunk carries the reason, so an earlier silent
    // chunk must not clear it.
    const chunks = [
      { content: 'Rebuilding the 30 seconds as a', additional_kwargs: {}, response_metadata: {} },
      {
        content: ' 23-shot',
        additional_kwargs: {},
        response_metadata: { finish_reason: 'length' },
      },
    ];
    class Stubbed extends ConcreteLangChainDeepSeekProvider {
      protected override buildModel(): never {
        return {
          async *stream() {
            yield* chunks;
          },
        } as never;
      }
    }
    const provider = new Stubbed({ name: 'deepseek', apiKey: 'k' } as ProviderConfig);
    const emitted: { type: string; truncated?: boolean }[] = [];
    for await (const chunk of provider.stream(request)) emitted.push(chunk);
    expect(emitted.at(-1)).toMatchObject({ type: 'done', truncated: true });
  });

  it('leaves the flag off a normal stop', async () => {
    const chunks = [
      { content: 'all done', additional_kwargs: {}, response_metadata: { finish_reason: 'stop' } },
    ];
    class Stubbed extends ConcreteLangChainDeepSeekProvider {
      protected override buildModel(): never {
        return {
          async *stream() {
            yield* chunks;
          },
        } as never;
      }
    }
    const provider = new Stubbed({ name: 'deepseek', apiKey: 'k' } as ProviderConfig);
    const emitted: { type: string; truncated?: boolean }[] = [];
    for await (const chunk of provider.stream(request)) emitted.push(chunk);
    expect(emitted.at(-1)).toEqual({ type: 'done', text: 'all done' });
  });
});

describe('DeepSeek reasoning transport', () => {
  it('emits reasoning as it streams, ahead of visible answer text', async () => {
    const chunks = [
      { content: '', additional_kwargs: { reasoning_content: 'first I check the cuts' } },
      { content: '', additional_kwargs: { reasoning_content: ' then the audio' } },
      { content: 'Done.', additional_kwargs: {} },
    ];
    class Stubbed extends ConcreteLangChainDeepSeekProvider {
      protected override buildModel(): never {
        return {
          async *stream() {
            yield* chunks;
          },
        } as never;
      }
    }
    const provider = new Stubbed({ name: 'deepseek', apiKey: 'k' } as ProviderConfig);
    const emitted: { type: string; text?: string }[] = [];
    for await (const chunk of provider.stream(request)) emitted.push(chunk);
    expect(emitted.filter((chunk) => chunk.type === 'reasoning-delta')).toEqual([
      { type: 'reasoning-delta', text: 'first I check the cuts' },
      { type: 'reasoning-delta', text: ' then the audio' },
    ]);
    expect(emitted.findIndex((chunk) => chunk.type === 'reasoning-delta')).toBeLessThan(
      emitted.findIndex((chunk) => chunk.type === 'text-delta'),
    );
    expect(emitted.at(-1)).toMatchObject({ type: 'done', text: 'Done.' });
  });

  it('returns reasoning from a non-streamed completion', async () => {
    class Stubbed extends ConcreteLangChainDeepSeekProvider {
      protected override buildModel(): never {
        return {
          async invoke() {
            return {
              content: 'Trimmed the intro.',
              additional_kwargs: { reasoning_content: 'the first 2s are silent' },
              tool_calls: [],
            };
          },
        } as never;
      }
    }
    const response = await new Stubbed({
      name: 'deepseek',
      apiKey: 'k',
    } as ProviderConfig).complete(request);
    expect(response.text).toBe('Trimmed the intro.');
    expect(response.reasoning).toBe('the first 2s are silent');
  });

  it('omits reasoning when the model returned none', async () => {
    class Stubbed extends ConcreteLangChainDeepSeekProvider {
      protected override buildModel(): never {
        return {
          async invoke() {
            return { content: 'Just the answer.', additional_kwargs: {}, tool_calls: [] };
          },
        } as never;
      }
    }
    const response = await new Stubbed({
      name: 'deepseek',
      apiKey: 'k',
    } as ProviderConfig).complete(request);
    expect(response.text).toBe('Just the answer.');
    expect(response).not.toHaveProperty('reasoning');
  });

  it('reads env safely where there is no process at all', () => {
    const original = globalThis.process;
    try {
      // @ts-expect-error simulating the sandboxed renderer global scope
      delete globalThis.process;
      expect(createProvider().name).toBe('mock');
    } finally {
      globalThis.process = original;
    }
  });
});
