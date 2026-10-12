"use client";

import { useState, useEffect, useRef } from "react";

/**
 * Numeric date input — DD/MM/YYYY format with auto-slash mask.
 * Value is YYYY-MM-DD (ISO) to stay compatible with existing state.
 */
export function NumericDateInput({
  value,
  onChange,
  className = "",
  required = false,
  ariaLabel,
}: {
  value: string; // YYYY-MM-DD
  onChange: (v: string) => void;
  className?: string;
  required?: boolean;
  ariaLabel?: string;
}) {
  const [text, setText] = useState("");
  const internal = useRef(false);

  // ISO -> DD/MM/YYYY
  useEffect(() => {
    if (internal.current) { internal.current = false; return; }
    if (!value) { setText(""); return; }
    const [y, m, d] = value.split("-");
    if (y && m && d) setText(`${d}/${m}/${y}`);
  }, [value]);

  const handle = (raw: string) => {
    // keep only digits, max 8
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    // format DD/MM/YYYY
    let out = digits;
    if (digits.length > 2) out = digits.slice(0, 2) + "/" + digits.slice(2);
    if (digits.length > 4) out = digits.slice(0, 2) + "/" + digits.slice(2, 4) + "/" + digits.slice(4);
    setText(out);
    // emit ISO when complete and valid
    if (digits.length === 8) {
      const d = digits.slice(0, 2), m = digits.slice(2, 4), y = digits.slice(4);
      const dd = parseInt(d, 10), mm = parseInt(m, 10);
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
        internal.current = true;
        onChange(`${y}-${m}-${d}`);
        return;
      }
    }
    if (digits.length === 0) {
      internal.current = true;
      onChange("");
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      dir="ltr"
      placeholder="DD/MM/YYYY"
      value={text}
      onChange={(e) => handle(e.target.value)}
      className={`field tabular-nums ${className}`}
      required={required}
      aria-label={ariaLabel}
      maxLength={10}
    />
  );
}
