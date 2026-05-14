import React from "react";
import { useError } from "../context/ErrorContext";

const ErrorBanner: React.FC = () => {
  const { error, setError } = useError();

  if (!error) return null;

  return (
    <div className="bg-red-100 text-red-800 p-4 rounded-md shadow-md mb-4 relative">
      <strong>Error:</strong> {error}
      <button
        className="absolute top-1 right-2 text-xl"
        onClick={() => setError(null)}
        aria-label="Dismiss error"
      >
        ×
      </button>
    </div>
  );
};

export default ErrorBanner;
