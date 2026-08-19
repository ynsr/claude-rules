/**
 * DSH (DeepSeek Harness) path-scoped rules plugin.
 *
 * Re-exports the plugin factory and utility functions for external use.
 */

export { apply, discoverDshRules, formatDshRules, clearDshRuleCache } from "./plugin.ts";
export type { DshRulesConfig, LogLevel } from "./plugin.ts";