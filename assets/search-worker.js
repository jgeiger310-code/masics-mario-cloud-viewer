"use strict";
importScripts("search-core.js");

let engine = null;

self.addEventListener("message", (event) => {
  const message = event.data || {};
  try {
    if (message.type === "build") {
      engine = new self.MASICSSearchCore.SearchEngine(message.records || []);
      engine.build((percent) => self.postMessage({ type: "build-progress", percent }));
      self.postMessage({ type: "build-complete", count: engine.docs.length });
      return;
    }
    if (message.type === "search") {
      if (!engine) throw new Error("The search index is not ready yet.");
      const response = engine.search(message.query || "", message.options || {});
      self.postMessage({ type: "search-results", requestId: message.requestId, ...response });
    }
  } catch (error) {
    self.postMessage({ type: "error", requestId: message.requestId, message: error?.message || String(error) });
  }
});
