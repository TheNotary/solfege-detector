"""CLI entrypoint for the solfege-detector server."""

import argparse
import logging

import uvicorn


def main():
    parser = argparse.ArgumentParser(description="Solfege Detector — real-time solfege syllable detection server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="Bind port (default: 8000)")
    parser.add_argument(
        "--confidence-threshold",
        type=float,
        default=0.5,
        help="Default confidence threshold for detection (default: 0.5)",
    )
    parser.add_argument("--log-level", default="info", help="Log level (default: info)")
    args = parser.parse_args()

    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))

    uvicorn.run(
        "solfege_detector.server:app",
        host=args.host,
        port=args.port,
        log_level=args.log_level.lower(),
    )


if __name__ == "__main__":
    main()
