import type { ProviderAdapter } from "../base";
import { namespacedToolName, requiresToolCall, toolChoiceToolPredicate, type AdapterEvent, type OcxParsedRequest } from "../../types";
import { releaseTranslatedEvent, retainTranslatedEvent, type TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterTierMetadata } from "../../providers/fastwire";
import { isTruncatedStopReason } from "../../responses/truncated-stop-reason";

function requiredNames(parsed: OcxParsedRequest): ReadonlySet<string> | undefined {
  if (!requiresToolCall(parsed.options.toolChoice)) return undefined;
  const tools = parsed.context.tools ?? [];
  // Sidecars own their own tool lifecycle; this boundary validates client-executed calls only.
  if (tools.some(t => t.webSearch || t.imageGeneration || t.videoGeneration || t.advisor)) return undefined;
  const allowed = toolChoiceToolPredicate(parsed.options.toolChoice, tools);
  return new Set(tools.filter(allowed).map(t => namespacedToolName(t.namespace, t.name)));
}

function terminalGuard(names: ReadonlySet<string> | undefined): (event: AdapterEvent) => AdapterEvent {
  let pending = false;
  let fulfilled = false;
  let failed = false;
  return event => {
    if (event.type === "tool_call_start") pending = names?.has(event.name) ?? false;
    if (event.type === "tool_call_end") { fulfilled ||= pending; pending = false; }
    if (event.type === "error" || event.type === "incomplete") failed = true;
    if (event.type !== "done" || names === undefined || fulfilled || failed || isTruncatedStopReason(event.stopReason)) return event;
    // Preserve delivered output and consumption. A mandatory call is a contract, not a hint
    // that permits replaying an already-visible turn or silently reporting text as success.
    return {
      type: "error", status: 502, errorType: "upstream_error", code: "required_tool_not_called",
      message: "The upstream response completed without the required client tool call.",
      retryable: false, usage: event.usage,
    };
  };
}

/** Keep the same per-request lifetime as the Chat adapter's tool-name registry. */
export function withRequiredChatToolResult(adapter: ProviderAdapter): ProviderAdapter {
  let names: ReadonlySet<string> | undefined;
  return {
    ...adapter,
    buildRequest(parsed, incoming) {
      names = requiredNames(parsed);
      return adapter.buildRequest(parsed, incoming);
    },
    async *parseStream(response, budget, tierMetadata) {
      const guard = terminalGuard(names);
      for await (const event of adapter.parseStream(response, budget, tierMetadata)) yield guard(event);
    },
    ...(adapter.parseResponse ? {
      async parseResponse(response: Response, budget: TranslatorBudget, tierMetadata?: AdapterTierMetadata) {
        const events = await adapter.parseResponse!(response, budget, tierMetadata);
        const guard = terminalGuard(names);
        for (let i = 0; i < events.length; i++) {
          const original = events[i]!;
          const guarded = guard(original);
          if (guarded !== original) {
            releaseTranslatedEvent(original, budget);
            retainTranslatedEvent(guarded, budget);
            events[i] = guarded;
          }
        }
        return events;
      },
    } : {}),
  };
}
