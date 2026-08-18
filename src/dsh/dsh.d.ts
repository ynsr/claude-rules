/**
 * Ambient type declarations for DSH (DeepSeek Harness) packages.
 * These are only used when the plugin is loaded by the DSH runtime.
 * Not included in the omp/Pi build.
 */

declare module "@deepseek-ai/cordis" {
  // Minimal Context type matching what the DSH plugin uses
  export interface Context {
    on<K extends string>(name: K, listener: (...args: unknown[]) => unknown): () => boolean;
    get<T = unknown>(name: string): T | undefined;
    logger: { warn(msg: string, ...args: unknown[]): void };
    effect(fn: () => void | (() => void), name?: string): void;
    plugin<T>(plugin: (ctx: Context, config?: T) => void, config?: T): void;
  }
}

declare module "@deepseek-ai/dsh-llm" {
  export function createUserMessage<T extends Record<string, unknown>>(
    input: T & { readonly id?: never; readonly role?: never },
  ): T & { id: string; role: "user" };
}