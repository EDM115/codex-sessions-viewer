import { payloadObject, type CodexEvent, type TurnScopedEvent } from "./eventSchema.ts";

export interface AssembledTurnEvents {
  id: string;
  sourceTurnId: string | null;
  index: number;
  events: TurnScopedEvent[];
}

export interface TurnAssemblyResult {
  turns: AssembledTurnEvents[];
  unscopedEvents: CodexEvent[];
}

interface MutableTurn {
  id: string;
  sourceTurnId: string | null;
  index: number;
  provisional: boolean;
  closed: boolean;
  events: TurnScopedEvent[];
}

function explicitTurnId(event: CodexEvent): string | null {
  const payload = payloadObject(event);
  if (typeof payload?.["turn_id"] === "string" && payload["turn_id"] !== "") {
    return payload["turn_id"];
  }
  const passthrough = payload?.["internal_chat_message_metadata_passthrough"];
  if (passthrough !== null && typeof passthrough === "object" && !Array.isArray(passthrough)) {
    return typeof passthrough["turn_id"] === "string" && passthrough["turn_id"] !== ""
      ? passthrough["turn_id"]
      : null;
  }
  const metadata = payload?.["metadata"];
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    return typeof metadata["turn_id"] === "string" && metadata["turn_id"] !== ""
      ? metadata["turn_id"]
      : null;
  }
  return null;
}

function beginsPrompt(event: CodexEvent): boolean {
  return event.type === "event_msg" && event.payloadType === "user_message";
}

function beginsOrNamesTurn(event: CodexEvent): boolean {
  return (
    event.type === "turn_context" ||
    (event.type === "event_msg" && event.payloadType === "task_started")
  );
}

function closesTurn(event: CodexEvent): boolean {
  return (
    event.type === "event_msg" &&
    (event.payloadType === "task_complete" || event.payloadType === "turn_aborted")
  );
}

function belongsToTurn(event: CodexEvent): boolean {
  if (event.type === "response_item" || event.type === "compacted") {
    return true;
  }
  if (event.type === "turn_context") {
    return true;
  }
  if (event.type !== "event_msg") {
    return false;
  }
  return event.payloadType !== "thread_settings_applied";
}

function addEvent(turn: MutableTurn, event: CodexEvent): void {
  turn.events.push({ event, turnId: turn.id });
}

function renameTurn(turn: MutableTurn, id: string, sourceTurnId: string): void {
  turn.id = id;
  turn.sourceTurnId = sourceTurnId;
  turn.provisional = false;
  for (const scoped of turn.events) {
    scoped.turnId = id;
  }
}

export function assembleTurnEvents(
  events: readonly CodexEvent[],
  sessionId: string,
): TurnAssemblyResult {
  const turns: MutableTurn[] = [];
  const unscopedEvents: CodexEvent[] = [];
  let active: MutableTurn | null = null;

  const viewerTurnId = (sourceTurnId: string, event: CodexEvent): string =>
    turns.some((turn) => turn.sourceTurnId === sourceTurnId)
      ? `${sourceTurnId}:${event.id}`
      : sourceTurnId;

  const createTurn = (
    sourceTurnId: string | null,
    provisional: boolean,
    event?: CodexEvent,
  ): MutableTurn => {
    const turn: MutableTurn = {
      id:
        sourceTurnId === null
          ? `${sessionId}:turn-${turns.length}`
          : viewerTurnId(sourceTurnId, event!),
      sourceTurnId,
      index: turns.length,
      provisional,
      closed: false,
      events: [],
    };
    turns.push(turn);
    return turn;
  };

  for (const event of events) {
    const explicit = explicitTurnId(event);
    if (beginsPrompt(event)) {
      if (active === null || active.closed) {
        active = createTurn(null, true);
      }
      addEvent(active, event);
      continue;
    }

    if (beginsOrNamesTurn(event)) {
      if (active !== null && active.provisional && !active.closed && explicit !== null) {
        renameTurn(active, viewerTurnId(explicit, active.events[0]?.event ?? event), explicit);
      } else if (
        active === null ||
        active.closed ||
        (explicit !== null && active.sourceTurnId !== explicit)
      ) {
        active = createTurn(explicit, explicit === null, event);
      }
      addEvent(active, event);
      continue;
    }

    if (explicit !== null) {
      if (active === null || (active.sourceTurnId !== explicit && !active.provisional)) {
        active = createTurn(explicit, false, event);
      } else if (active.provisional) {
        renameTurn(active, viewerTurnId(explicit, active.events[0]?.event ?? event), explicit);
      }
      addEvent(active, event);
      if (closesTurn(event)) {
        active.closed = true;
      }
      continue;
    }

    if (active !== null && belongsToTurn(event)) {
      addEvent(active, event);
      continue;
    }

    unscopedEvents.push(event);
  }

  return {
    turns: turns.map(({ id, sourceTurnId, index, events: turnEvents }) => ({
      id,
      sourceTurnId,
      index,
      events: turnEvents,
    })),
    unscopedEvents,
  };
}
