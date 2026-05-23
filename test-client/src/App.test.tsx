/**
 * @vitest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { ErrorProvider } from "./context/ErrorContext";
import App from "./App";

function renderAtPath(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ErrorProvider>
        <App />
      </ErrorProvider>
    </MemoryRouter>
  );
}

describe("App routing", () => {
  it("renders MainMenu at the root path", () => {
    renderAtPath("/");
    expect(screen.getByText("Solfege Detector")).toBeDefined();
    expect(screen.getByText("Play Game")).toBeDefined();
  });

  it("does not show 'No routes matched' warning at root", () => {
    const { container } = renderAtPath("/");
    expect(container.textContent).not.toContain("No routes matched");
  });
});
