import { useEffect, useRef, useState } from "react";

interface UseSmoothedPitchReturn {
  displayPitchHz: number | null;
  opacity: number;
}

/**
 * Smooths raw pitch detection values using velocity-clamped movement.
 * The acceleration parameter controls how quickly the displayed pitch
 * can change direction/speed (higher = more responsive, lower = sluggish).
 * rootHz sets the initial pitch and derives the clamp range.
 */
export function useSmoothedPitch(
  pitchHz: number | null,
  acceleration: number,
  rootHz: number = 130.81,
): UseSmoothedPitchReturn {
  const [displayPitchHz, setDisplayPitchHz] = useState<number | null>(null);
  const [opacity, setOpacity] = useState(0);

  const stateRef = useRef({
    currentPitch: rootHz,
    velocity: 0,
    opacity: 0,
    lastTime: 0,
  });

  const pitchRef = useRef(pitchHz);
  pitchRef.current = pitchHz;
  const accelRef = useRef(acceleration);
  accelRef.current = acceleration;
  const rootHzRef = useRef(rootHz);
  rootHzRef.current = rootHz;

  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const DRAG = 8.0; // Deceleration coefficient when no pitch
    const OPACITY_FADE_IN_RATE = 4.0; // Per second
    const OPACITY_FADE_OUT_RATE = 2.0; // Per second
    // Scale acceleration: slider value maps to Hz/s^2
    const ACCEL_SCALE = 800;

    const animate = (timestamp: number) => {
      const state = stateRef.current;
      const dt = state.lastTime === 0 ? 1 / 60 : (timestamp - state.lastTime) / 1000;
      state.lastTime = timestamp;

      // Clamp dt to avoid jumps on tab-switch
      const clampedDt = Math.min(dt, 0.1);

      const targetPitch = pitchRef.current;
      const maxAccel = accelRef.current * ACCEL_SCALE;

      if (targetPitch !== null) {
        // Compute desired acceleration toward target
        const error = targetPitch - state.currentPitch;
        // Critically-damped approach: desired accel proportional to error, with damping
        const springForce = error * 20; // spring constant
        const dampingForce = -state.velocity * 6; // damping
        let desiredAccel = springForce + dampingForce;

        // Clamp acceleration magnitude
        if (Math.abs(desiredAccel) > maxAccel) {
          desiredAccel = Math.sign(desiredAccel) * maxAccel;
        }

        state.velocity += desiredAccel * clampedDt;
        state.currentPitch += state.velocity * clampedDt;

        // Fade in
        state.opacity = Math.min(1, state.opacity + OPACITY_FADE_IN_RATE * clampedDt);
      } else {
        // No pitch detected - decelerate and fade out
        state.velocity *= Math.max(0, 1 - DRAG * clampedDt);

        // Still update position from remaining velocity
        state.currentPitch += state.velocity * clampedDt;

        // Fade out
        state.opacity = Math.max(0, state.opacity - OPACITY_FADE_OUT_RATE * clampedDt);
      }

      // Clamp pitch to reasonable range relative to root
      const minHz = rootHzRef.current * 0.7;
      const maxHz = rootHzRef.current * 2.2;
      state.currentPitch = Math.max(minHz, Math.min(maxHz, state.currentPitch));

      if (state.opacity > 0.01) {
        setDisplayPitchHz(state.currentPitch);
      } else {
        setDisplayPitchHz(null);
      }
      setOpacity(state.opacity);

      rafRef.current = requestAnimationFrame(animate);
    };

    stateRef.current.lastTime = 0;
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return { displayPitchHz, opacity };
}
