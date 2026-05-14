import { useEffect, useRef } from "react";
import confetti from "canvas-confetti";
import type { GameNote } from "../hooks/useGameEngine";

interface NoteSpriteProps {
  note: GameNote;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export default function NoteSprite({ note, containerRef }: NoteSpriteProps) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (note.state === "hit" && !firedRef.current) {
      firedRef.current = true;
      // Fire confetti at the note's screen position
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const x = (rect.left + (note.x / 100) * rect.width) / window.innerWidth;
        const y = (rect.top + (note.y / 100) * rect.height) / window.innerHeight;
        confetti({
          particleCount: 60,
          spread: 50,
          origin: { x, y },
          colors: ["#ff0", "#0ff", "#f0f", "#0f0", "#f90"],
          startVelocity: 20,
          gravity: 0.6,
          ticks: 80,
        });
      }
    }
  }, [note.state, note.x, note.y, containerRef]);

  const isHit = note.state === "hit";
  const isMissed = note.state === "missed";

  return (
    <div
      className={`note-sprite ${isHit ? "note-hit" : ""} ${isMissed ? "note-missed" : ""}`}
      style={{
        left: `${note.x}%`,
        top: `${note.y}%`,
      }}
    >
      ♩
    </div>
  );
}
