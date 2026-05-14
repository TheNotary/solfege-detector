import { useCallback, useEffect, useRef, useState } from "react";

export interface DetectionMessage {
  type: "detection";
  syllable: string;
  confidence: number;
}

interface UseWebSocketReturn {
  send: (data: Blob | ArrayBuffer) => void;
  sendConfig: (config: { confidence_threshold: number }) => void;
  sendNoteEvent: (syllable: string, hit: boolean) => void;
  lastMessage: DetectionMessage | null;
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
}

const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1_000;

export function useWebSocket(url: string): UseWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<DetectionMessage | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const urlRef = useRef(url);
  urlRef.current = url;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connectWs = useCallback(() => {
    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    intentionalCloseRef.current = false;
    const ws = new WebSocket(urlRef.current);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      setIsConnected(true);
      reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === "detection") {
            setLastMessage(parsed as DetectionMessage);
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      wsRef.current = null;

      if (!intentionalCloseRef.current) {
        // Exponential backoff reconnect
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);
        reconnectTimerRef.current = setTimeout(connectWs, delay);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };

    wsRef.current = ws;
  }, []);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    clearReconnectTimer();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  }, [clearReconnectTimer]);

  const send = useCallback((data: Blob | ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const sendConfig = useCallback(
    (config: { confidence_threshold: number }) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(config));
      }
    },
    []
  );

  const sendNoteEvent = useCallback(
    (syllable: string, hit: boolean) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "note_event",
            syllable,
            hit,
            timestamp: new Date().toISOString(),
          })
        );
      }
    },
    []
  );

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    connectWs();
    return () => {
      disconnect();
    };
  }, [connectWs, disconnect]);

  return {
    send,
    sendConfig,
    sendNoteEvent,
    lastMessage,
    isConnected,
    connect: connectWs,
    disconnect,
  };
}
