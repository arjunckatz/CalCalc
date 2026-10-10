import { useRef, useState, type FormEvent } from "react";
import { ApiError } from "./api";
import type { ClientError } from "./contracts";
import type { WebClient } from "./store";

interface TurnAttempt {
  foodDayId: string;
  message: string;
  idempotencyKey: string;
  currentLocalDate: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export function Chat({
  client,
  foodDayId,
  disabled,
}: {
  client: WebClient;
  foodDayId: string | null;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<TurnAttempt | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const inFlight = useRef(false);

  async function send(attempt: TurnAttempt) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await client.sendTurn(attempt);
      setMessages((current) => [
        ...current,
        { role: "assistant", text: result.response },
      ]);
      setPending(null);
    } catch (failure) {
      const detail =
        failure instanceof ApiError
          ? failure.detail
          : {
              kind: "server" as const,
              message:
                "Could not confirm this message. Retry the same request.",
              retryable: true,
            };
      setError(detail);
      if (!detail.retryable) setPending(null);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      disabled ||
      foodDayId === null ||
      pending !== null ||
      inFlight.current ||
      draft.trim() === ""
    )
      return;
    const attempt: TurnAttempt = {
      foodDayId,
      message: draft,
      idempotencyKey: client.newTurnKey(),
      currentLocalDate: client.currentLocalDate(),
    };
    setPending(attempt);
    setMessages((current) => [...current, { role: "user", text: draft }]);
    setDraft("");
    void send(attempt);
  }

  return (
    <section className="card chat" aria-labelledby="chat-heading">
      <h2 id="chat-heading">Conversation</h2>
      {foodDayId === null && <p>Create a FoodDay to start chatting.</p>}
      <div
        className="chat-transcript"
        role="log"
        aria-label="Conversation transcript"
      >
        {messages.map((message, index) => (
          <p key={index} className={`chat-message ${message.role}`}>
            <span className="chat-speaker">
              {message.role === "user" ? "You" : "CalCalc"}
            </span>
            {message.text}
          </p>
        ))}
      </div>
      {sending && <p role="status">CalCalc is responding…</p>}
      {error && (
        <p role="alert" className="error">
          {error.message}
        </p>
      )}
      {pending !== null && error?.retryable && (
        <button
          type="button"
          className="secondary"
          disabled={disabled || sending}
          onClick={() => void send(pending)}
        >
          Retry same message
        </button>
      )}
      <form onSubmit={submit}>
        <label htmlFor="chat-message">Message</label>
        <input
          id="chat-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled || foodDayId === null || pending !== null}
          maxLength={4000}
        />
        <button
          type="submit"
          disabled={
            disabled ||
            foodDayId === null ||
            pending !== null ||
            sending ||
            draft.trim() === ""
          }
        >
          Send
        </button>
      </form>
    </section>
  );
}
