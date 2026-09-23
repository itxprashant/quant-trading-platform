"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "qtp:chart-visible";

/** Per-browser chart preference; defaults to visible. */
export function useChartVisible(): [boolean, () => void] {
  const [visible, setVisible] = useState(true);

  // Read after mount so the server render and first client render agree.
  useEffect(() => {
    if (window.localStorage.getItem(KEY) === "0") setVisible(false);
  }, []);

  const toggle = useCallback(() => {
    setVisible((v) => {
      window.localStorage.setItem(KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  return [visible, toggle];
}
