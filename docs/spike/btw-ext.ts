import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sidechat", {
    description: "Ask a side question via runEphemeralTurn without touching main history",
    handler: async (args, ctx) => {
      if (!ctx.runEphemeralTurn) {
        ctx.ui.notify("This host does not support ephemeral turns", "error");
        return;
      }
      const promptText = (typeof args === "string" ? args : "").trim() || "(no question given)";
      try {
        const { replyText } = await ctx.runEphemeralTurn({
          promptText,
          tools: false,
          maxTokens: 512,
        });
        ctx.ui.notify(`SIDECHAT_ANSWER: ${replyText}`, "info");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`SIDECHAT_ERROR: ${message}`, "error");
      }
    },
  });
}
