const HTMLElementBase = globalThis.HTMLElement ?? class {};

export interface ChuskyChatOptions {
  endpoint: string;
  title?: string;
  greeting?: string;
  accentColor?: string;
}

type WidgetEvent = { type?: string; text?: string; message?: string; error?: string; conversationId?: string };

/** A dependency-free chat element. The host owns auth and keeps the API key server-side. */
export class ChuskyChatElement extends HTMLElementBase {
  private messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  private busy = false;
  private conversationId?: string;

  connectedCallback(): void {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.render();
  }

  private options(): ChuskyChatOptions {
    return {
      endpoint: this.getAttribute("endpoint") ?? "/api/chusky/chat",
      title: this.getAttribute("title") ?? "Chat with us",
      greeting: this.getAttribute("greeting") ?? "How can I help?",
      accentColor: this.getAttribute("accent-color") ?? "#111111",
    };
  }

  private render(): void {
    if (!this.shadowRoot) return;
    const options = this.options();
    const messages = this.messages.length ? this.messages.map((message) => `
      <div class="message ${message.role}" aria-label="${message.role === "user" ? "You" : "Chusky"}">${escapeHtml(message.text).replace(/\n/g, "<br />")}</div>`).join("") : `<p class="greeting">${escapeHtml(options.greeting ?? "How can I help?")}</p>`;
    const accent = escapeHtml(options.accentColor ?? "#111111");
    this.shadowRoot.innerHTML = `
      <style>
        :host { color: #1d1d1b; font: 14px/1.45 system-ui, sans-serif; }
        .shell { width: min(360px, calc(100vw - 32px)); border: 1px solid #d9d9d2; border-radius: 16px; background: #fff; box-shadow: 0 16px 45px rgb(0 0 0 / 12%); overflow: hidden; }
        header { padding: 14px 16px; color: #fff; background: ${accent}; }
        header strong { font-size: 14px; }
        .messages { display: grid; gap: 9px; max-height: 320px; overflow: auto; padding: 16px; background: #f7f7f4; }
        .greeting { margin: 0; color: #696963; }
        .message { max-width: 84%; padding: 9px 11px; border-radius: 11px; overflow-wrap: anywhere; }
        .message.user { justify-self: end; color: #fff; background: ${accent}; }
        .message.assistant { justify-self: start; border: 1px solid #deded7; background: #fff; }
        form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e3e3dd; background: #fff; }
        textarea { flex: 1; min-height: 38px; max-height: 110px; resize: vertical; border: 1px solid #cfcfc7; border-radius: 9px; padding: 9px; font: inherit; }
        button { align-self: end; border: 0; border-radius: 9px; padding: 10px 12px; color: #fff; background: ${accent}; cursor: pointer; }
        button:disabled { cursor: wait; opacity: .55; }
        textarea:focus-visible, button:focus-visible { outline: 2px solid #6a8cff; outline-offset: 2px; }
      </style>
      <section class="shell" aria-label="${escapeHtml(options.title ?? "Chat")}">
        <header><strong>${escapeHtml(options.title ?? "Chat with us")}</strong></header>
        <div class="messages" role="log" aria-live="polite">${messages}</div>
        <form>
          <textarea name="message" maxlength="4000" aria-label="Message" placeholder="Write a message…" required></textarea>
          <button type="submit" ${this.busy ? "disabled" : ""}>${this.busy ? "…" : "Send"}</button>
        </form>
      </section>`;
    this.shadowRoot.querySelector("form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = this.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement | null;
      if (input?.value.trim()) void this.send(input.value.trim());
    });
    const log = this.shadowRoot.querySelector(".messages");
    if (log) log.scrollTop = log.scrollHeight;
  }

  private async send(message: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.messages.push({ role: "user", text: message });
    this.messages.push({ role: "assistant", text: "" });
    this.render();
    try {
      const response = await fetch(this.options().endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
        body: JSON.stringify({ message, conversationId: this.conversationId }),
      });
      if (!response.ok) throw new Error("The assistant could not respond.");
      await this.consume(response);
    } catch (error) {
      this.messages[this.messages.length - 1] = { role: "assistant", text: error instanceof Error ? error.message : "The assistant could not respond." };
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async consume(response: Response): Promise<void> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("ndjson") || !response.body) {
      const body = await response.json().catch(async () => ({ text: await response.text() })) as WidgetEvent;
      if (body.conversationId) this.conversationId = body.conversationId;
      this.messages[this.messages.length - 1].text = body.text ?? body.message ?? "";
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) this.consumeEvent(line);
      if (done) break;
    }
    if (pending.trim()) this.consumeEvent(pending);
  }

  private consumeEvent(line: string): void {
    if (!line.trim()) return;
    const event = JSON.parse(line) as WidgetEvent;
    if (event.conversationId) this.conversationId = event.conversationId;
    if (event.type === "run.delta" || event.type === "message.delta") this.messages[this.messages.length - 1].text += event.text ?? "";
    if (event.type === "run.approval_required" || event.type === "approval_required") this.messages[this.messages.length - 1].text += "\nThis action is waiting for approval.";
    if (event.type === "error") this.messages[this.messages.length - 1].text += event.error ?? event.message ?? "The assistant encountered an error.";
    this.render();
  }
}

export function defineChuskyChat(tagName = "chusky-chat"): void {
  if (typeof customElements === "undefined" || customElements.get(tagName)) return;
  customElements.define(tagName, ChuskyChatElement as CustomElementConstructor);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}
