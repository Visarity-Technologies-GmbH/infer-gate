import React from "react";
import { number } from "../api/client";
import { Empty } from "./ui";

export function Activity({ days, label = "Daily reported total tokens. Exact counts are available in the usage breakdown grouped by day." }) {
  const valid = days.filter((d) => d.total_tokens != null);
  if (!valid.length)
    return (
      <Empty
        title="Your activity starts here"
        detail="Send a request through InferGate to see reported token usage."
      />
    );
  const max = Math.max(...valid.map((d) => Number(d.total_tokens)), 1);
  return (
    <div className="activity">
      <div className="chart-axis">
        <span>{number(max)}</span>
        <span>{number(max / 2)}</span>
        <span>0</span>
      </div>
      <div
        className="bars"
        role="img"
        aria-label={label}
      >
        {days.map((d, i) => (
          <div
            className="bar-column"
            key={i}
            title={`${String(d.bucket).slice(0, 10)}: ${number(d.total_tokens)} tokens`}
          >
            <div
              className="bar"
              style={{
                height: `${d.total_tokens == null ? 0 : Math.max((Number(d.total_tokens) / max) * 100, 1)}%`,
              }}
            />
            <small>
              {i === 0 || i === days.length - 1 || days.length < 8
                ? String(d.bucket).slice(5, 10)
                : ""}
            </small>
          </div>
        ))}
      </div>
    </div>
  );
}
