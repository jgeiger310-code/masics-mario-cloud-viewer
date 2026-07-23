(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MASICSSearchCore = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by", "for", "from",
    "had", "has", "have", "he", "her", "hers", "him", "his", "i", "in", "into", "is", "it",
    "its", "me", "my", "of", "on", "or", "our", "ours", "she", "that", "the", "their", "theirs",
    "them", "they", "this", "to", "was", "we", "were", "with", "you", "your"
  ]);

  const FIELD_ALIASES = Object.freeze({
    file: "filename", filename: "filename", name: "filename",
    path: "path", folder: "path",
    mario: "mario_notes", note: "mario_notes", notes: "mario_notes",
    ai: "ai_note", description: "ai_note",
    ocr: "ocr_text",
    transcript: "transcript_text", audio: "transcript_text",
    type: "file_type", ext: "file_type",
    decision: "decision", tag: "decision",
    id: "identifiers", mfr: "identifiers"
  });

  const FIELD_WEIGHTS = Object.freeze({
    filename: 10,
    identifiers: 9,
    mario_notes: 7,
    ai_note: 5,
    ocr_text: 3,
    transcript_text: 3,
    path: 2,
    file_type: 1,
    decision: 1
  });

  const SYNONYM_GROUPS = [
    ["foil", "public records", "public record", "freedom of information", "records request", "foil request"],
    ["certificate of occupancy", "c of o", "co certificate", "occupancy certificate", "c/o"],
    ["kennel", "dog license", "dog licensing", "canine license", "kennel permit"],
    ["building permit", "code enforcement", "building code", "zoning permit"],
    ["town board", "board meeting", "meeting minutes", "town minutes"],
    ["missing", "not produced", "not disclosed", "withheld", "omitted"],
    ["notice of claim", "claim notice", "noc", "notices of claim"],
    ["text message", "sms", "messenger message", "chat message"],
    ["email", "e-mail", "gmail message"],
    ["privileged", "attorney client", "work product"],
    // Local people / places (case-specific boosts for phrase discovery)
    ["frank miller", "miller frank", "atty miller", "attorney miller"],
    ["farrington", "lonnie farrington", "kay farrington", "the farringtons"],
    ["franklinville", "town of franklinville", "franklinville ny"],
    ["machias", "town of machias"]
  ];

  // phrase -> list of related phrases (kept as phrases, not exploded into stopword-y tokens)
  const synonymLookup = new Map();
  SYNONYM_GROUPS.forEach((group) => {
    const normalizedGroup = group.map(normalizeText).filter(Boolean);
    normalizedGroup.forEach((phrase) => synonymLookup.set(phrase, normalizedGroup));
  });

  function normalizeText(value) {
    return String(value == null ? "" : value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/[^a-z0-9@._+\-\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(value, options = {}) {
    const keepStopWords = Boolean(options.keepStopWords);
    return normalizeText(value)
      .split(/\s+/)
      .filter((token) => token.length > 1 && (keepStopWords || !STOP_WORDS.has(token)));
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;
    const input = String(text || "").replace(/^\uFEFF/, "");
    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"' && input[i + 1] === '"') {
          value += '"';
          i += 1;
        } else if (ch === '"') {
          quoted = false;
        } else {
          value += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        row.push(value);
        value = "";
      } else if (ch === "\n") {
        row.push(value.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        value = "";
      } else {
        value += ch;
      }
    }
    if (value.length || row.length) {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
    }
    if (!rows.length) return [];
    const headers = rows.shift().map((header) => String(header || "").trim());
    return rows
      .filter((cells) => cells.some((cell) => String(cell || "").trim()))
      .map((cells) => Object.fromEntries(headers.map((header, index) => [header, cells[index] == null ? "" : cells[index]])));
  }

  function parseQuery(input) {
    const text = String(input || "").trim();
    const positiveTerms = [];
    const negativeTerms = [];
    const phrases = [];
    const negativePhrases = [];
    const regex = /(-)?(?:(\w+):)?(?:"([^"]+)"|(\S+))/g;
    let match;
    let sawExplicitPhrase = false;
    let sawFielded = false;
    while ((match = regex.exec(text))) {
      const negative = Boolean(match[1]);
      const rawField = String(match[2] || "").toLowerCase();
      const field = FIELD_ALIASES[rawField] || "";
      if (field) sawFielded = true;
      const phrase = match[3];
      const term = match[4];
      if (phrase != null) {
        sawExplicitPhrase = true;
        const normalized = normalizeText(phrase);
        if (!normalized) continue;
        (negative ? negativePhrases : phrases).push({ value: normalized, field });
      } else {
        // Drop stop words here — they are not indexed, so requiring them made
        // queries like "notice of claim" / "certificate of occupancy" return 0 hits.
        const normalizedTokens = tokenize(term, { keepStopWords: false });
        normalizedTokens.forEach((value) => {
          if (!value) return;
          (negative ? negativeTerms : positiveTerms).push({ value, field });
        });
      }
    }

    // Unquoted multi-word free-text: also treat the full query as a phrase candidate.
    // That recovers exact legal phrases and improves ranking without forcing quotes.
    if (!sawExplicitPhrase && !sawFielded) {
      const freeText = normalizeText(text.replace(/-/g, " "));
      const contentTokens = tokenize(freeText, { keepStopWords: false });
      if (contentTokens.length >= 2) {
        phrases.push({ value: freeText, field: "", auto: true });
      }
      // Also register known synonym-group phrases present in the free text.
      synonymLookup.forEach((_, phrase) => {
        if (phrase.includes(" ") && freeText.includes(phrase) && phrase !== freeText) {
          phrases.push({ value: phrase, field: "", auto: true });
        }
      });
    }

    return { text, positiveTerms, negativeTerms, phrases, negativePhrases };
  }

  function levenshtein(a, b, maxDistance = Infinity) {
    const left = String(a || "");
    const right = String(b || "");
    if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
    if (left === right) return 0;
    if (!left.length) return right.length;
    if (!right.length) return left.length;
    let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i += 1) {
      const current = [i];
      let rowMin = current[0];
      for (let j = 1; j <= right.length; j += 1) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        const score = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
        current[j] = score;
        rowMin = Math.min(rowMin, score);
      }
      if (rowMin > maxDistance) return maxDistance + 1;
      previous = current;
    }
    return previous[right.length];
  }

  function truthy(value) {
    return value === true || String(value || "").toLowerCase() === "true" || String(value || "") === "1";
  }

  function normalizeRecord(record, index) {
    const identifiers = [record.review_id, record.mfr_request_ids, record.display?.mfr_request_ids]
      .filter(Boolean).join(" ");
    const normalized = {
      index,
      review_id: String(record.review_id || record.id || `record-${index}`),
      queue_number: Number(record.queue_number || record.queue || index + 1) || index + 1,
      filename: String(record.filename || record.name || "Untitled file"),
      file_type: String(record.file_type || record.extension || "").replace(/^\./, "").toLowerCase(),
      decision: String(record.decision || "").toLowerCase(),
      dropbox_path: String(record.dropbox_path || record.path || ""),
      mario_notes: String(record.mario_notes || record.mario_note || ""),
      ai_note: String(record.ai_note || record.description || ""),
      ocr_text: String(record.ocr_text || record.ocr || ""),
      transcript_text: String(record.transcript_text || record.transcript || ""),
      identifiers,
      has_ocr_sidecar: truthy(record.has_ocr_sidecar) || Boolean(record.ocr_text || record.ocr),
      has_transcript_sidecar: truthy(record.has_transcript_sidecar) || Boolean(record.transcript_text || record.transcript),
      years: Array.isArray(record.years) ? record.years.map(Number).filter(Number.isFinite) : [],
      raw: record
    };
    normalized.path = normalized.dropbox_path;
    normalized._fields = {};
    Object.keys(FIELD_WEIGHTS).forEach((field) => {
      normalized._fields[field] = normalizeText(normalized[field]);
    });
    normalized._combined = Object.values(normalized._fields).join(" ");
    return normalized;
  }

  function postingAdd(indexMap, term, docIndex, amount) {
    let postings = indexMap.get(term);
    if (!postings) {
      postings = new Map();
      indexMap.set(term, postings);
    }
    postings.set(docIndex, (postings.get(docIndex) || 0) + amount);
  }

  function fieldMatchesPhrase(doc, phrase) {
    if (phrase.field) return doc._fields[phrase.field]?.includes(phrase.value) ? phrase.field : "";
    const order = ["filename", "identifiers", "mario_notes", "ai_note", "ocr_text", "transcript_text", "path"];
    return order.find((field) => doc._fields[field]?.includes(phrase.value)) || "";
  }

  function recordPassesFilters(doc, filters = {}) {
    if (filters.decisions?.length && !filters.decisions.includes(doc.decision || "pending")) return false;
    if (filters.fileTypes?.length && !filters.fileTypes.includes(doc.file_type || "unknown")) return false;
    if (filters.hasOcr === true && !doc.has_ocr_sidecar) return false;
    if (filters.hasTranscript === true && !doc.has_transcript_sidecar) return false;
    if (filters.folder && !doc._fields.path.includes(normalizeText(filters.folder))) return false;
    if (Number.isFinite(filters.queueMin) && doc.queue_number < filters.queueMin) return false;
    if (Number.isFinite(filters.queueMax) && doc.queue_number > filters.queueMax) return false;
    if (Number.isFinite(filters.yearFrom) && !doc.years.some((year) => year >= filters.yearFrom)) return false;
    if (Number.isFinite(filters.yearTo) && !doc.years.some((year) => year <= filters.yearTo)) return false;
    return true;
  }

  class SearchEngine {
    constructor(records) {
      this.docs = (records || []).map(normalizeRecord);
      this.indexes = Object.fromEntries(Object.keys(FIELD_WEIGHTS).map((field) => [field, new Map()]));
      this.vocabulary = new Set();
      this.prefixVocabulary = new Map();
      this.built = false;
    }

    build(onProgress) {
      const total = this.docs.length || 1;
      this.docs.forEach((doc, docIndex) => {
        Object.entries(FIELD_WEIGHTS).forEach(([field, weight]) => {
          const frequencies = new Map();
          tokenize(doc[field]).forEach((term) => frequencies.set(term, Math.min(8, (frequencies.get(term) || 0) + 1)));
          frequencies.forEach((frequency, term) => {
            this.vocabulary.add(term);
            postingAdd(this.indexes[field], term, docIndex, weight * (1 + Math.log(frequency)));
          });
        });
        if (typeof onProgress === "function" && (docIndex % 200 === 0 || docIndex === total - 1)) {
          onProgress(Math.round(((docIndex + 1) / total) * 100));
        }
      });
      this.vocabulary.forEach((term) => {
        const prefix = term.slice(0, 3);
        if (!prefix) return;
        if (!this.prefixVocabulary.has(prefix)) this.prefixVocabulary.set(prefix, []);
        this.prefixVocabulary.get(prefix).push(term);
      });
      this.built = true;
      return this;
    }

    relatedTerms(term) {
      // Returns single-token expansions only (safe for inverted index).
      // Multi-word synonym phrases are handled separately as phrase expansions.
      const normalized = normalizeText(term);
      const exactGroup = synonymLookup.get(normalized) || [];
      const parts = [];
      exactGroup.forEach((phrase) => {
        if (phrase === normalized) return;
        const tokens = tokenize(phrase, { keepStopWords: false });
        // Only add single-token synonyms here (e.g. foil ↔ nothing multi-word).
        // Multi-word phrases like "public records" must NOT explode into "public"+"records"
        // or FOIL matches half the corpus.
        if (tokens.length === 1) parts.push(tokens[0]);
      });
      return [...new Set(parts)].filter((token) => token && token !== normalized).slice(0, 8);
    }

    relatedPhrases(term) {
      const normalized = normalizeText(term);
      const exactGroup = synonymLookup.get(normalized) || [];
      return exactGroup
        .filter((phrase) => phrase && phrase !== normalized && phrase.includes(" "))
        .slice(0, 8);
    }

    fuzzyTerms(term) {
      // Short tokens (names like lilah) produce noisy fuzzy hits — require longer stems.
      if (term.length < 6) return [];
      const maxDistance = term.length >= 9 ? 2 : 1;
      const candidates = this.prefixVocabulary.get(term.slice(0, 3)) || [];
      return candidates
        .filter((candidate) => candidate !== term && Math.abs(candidate.length - term.length) <= maxDistance + 1)
        .filter((candidate) => levenshtein(term, candidate, maxDistance) <= maxDistance)
        .sort((a, b) => levenshtein(term, a, maxDistance) - levenshtein(term, b, maxDistance) || a.localeCompare(b))
        .slice(0, 6);
    }

    termPostings(term, field) {
      if (field) return this.indexes[field]?.get(term) || new Map();
      const combined = new Map();
      Object.keys(FIELD_WEIGHTS).forEach((name) => {
        const postings = this.indexes[name].get(term);
        if (!postings) return;
        postings.forEach((score, docIndex) => combined.set(docIndex, (combined.get(docIndex) || 0) + score));
      });
      return combined;
    }

    search(input, options = {}) {
      if (!this.built) throw new Error("Search index has not been built.");
      const parsed = parseQuery(input);
      const filters = options.filters || {};
      const matchMode = options.matchMode === "any" ? "any" : "all";
      const useFuzzy = options.fuzzy !== false;
      const useRelated = options.related !== false;
      const scores = new Map();
      const matchedGroups = new Map();
      const expansionsUsed = [];

      // Collect related multi-word phrases once (applied as soft phrase boosts, not AND tokens).
      const relatedPhraseSet = new Map(); // value -> multiplier source label
      if (useRelated) {
        parsed.positiveTerms.forEach((queryTerm) => {
          if (queryTerm.field) return;
          this.relatedPhrases(queryTerm.value).forEach((phrase) => {
            if (!relatedPhraseSet.has(phrase)) relatedPhraseSet.set(phrase, queryTerm.value);
          });
        });
        // Whole-query synonym group (e.g. user typed "foil")
        const free = normalizeText(parsed.text.replace(/\w+:/g, " ").replace(/"/g, " ").replace(/-/g, " "));
        if (free && synonymLookup.has(free)) {
          synonymLookup.get(free).forEach((phrase) => {
            if (phrase.includes(" ") && phrase !== free && !relatedPhraseSet.has(phrase)) {
              relatedPhraseSet.set(phrase, free);
            }
          });
        }
      }

      parsed.positiveTerms.forEach((queryTerm, groupIndex) => {
        const expansions = [{ term: queryTerm.value, multiplier: 1, reason: "exact" }];
        if (useRelated) this.relatedTerms(queryTerm.value).forEach((term) => expansions.push({ term, multiplier: 0.55, reason: "related" }));
        if (useFuzzy) this.fuzzyTerms(queryTerm.value).forEach((term) => expansions.push({ term, multiplier: 0.35, reason: "fuzzy" }));
        const deduped = new Map();
        expansions.forEach((item) => {
          if (!deduped.has(item.term) || deduped.get(item.term).multiplier < item.multiplier) deduped.set(item.term, item);
        });
        const groupDocs = new Set();
        deduped.forEach((expansion) => {
          const postings = this.termPostings(expansion.term, queryTerm.field);
          postings.forEach((score, docIndex) => {
            groupDocs.add(docIndex);
            scores.set(docIndex, (scores.get(docIndex) || 0) + score * expansion.multiplier);
          });
          if (expansion.reason !== "exact" && postings.size) expansionsUsed.push(`${queryTerm.value} → ${expansion.term}`);
        });
        groupDocs.forEach((docIndex) => {
          if (!matchedGroups.has(docIndex)) matchedGroups.set(docIndex, new Set());
          matchedGroups.get(docIndex).add(groupIndex);
        });
      });

      // Required content-word groups (stopwords already removed).
      const positiveCount = parsed.positiveTerms.length;
      // Auto phrases are soft (boost only). Explicit "quoted" phrases without auto flag are hard in ALL mode.
      const hardPhrases = parsed.phrases.filter((phrase) => !phrase.auto);
      const softPhrases = parsed.phrases.filter((phrase) => phrase.auto);

      let candidateIndexes;
      if (parsed.positiveTerms.length) candidateIndexes = [...scores.keys()];
      else if (hardPhrases.length || softPhrases.length) {
        // Phrase-only query: scan docs that contain at least one phrase later.
        candidateIndexes = this.docs.map((_, index) => index);
      } else {
        candidateIndexes = this.docs.map((_, index) => index);
      }

      const normalizedNeedles = [
        ...parsed.positiveTerms.map((term) => term.value),
        ...parsed.phrases.map((phrase) => phrase.value),
        ...relatedPhraseSet.keys()
      ];
      const output = [];

      candidateIndexes.forEach((docIndex) => {
        const doc = this.docs[docIndex];
        if (!recordPassesFilters(doc, filters)) return;
        const matchedCount = matchedGroups.get(docIndex)?.size || 0;
        if (positiveCount && matchMode === "all" && matchedCount < positiveCount) return;
        if (positiveCount && matchMode === "any" && matchedCount === 0) return;

        for (const negative of parsed.negativeTerms) {
          if (negative.field ? doc._fields[negative.field]?.includes(negative.value) : doc._combined.includes(negative.value)) return;
        }
        for (const phrase of parsed.negativePhrases) {
          if (fieldMatchesPhrase(doc, phrase)) return;
        }

        let score = scores.get(docIndex) || 0;
        let hardPhraseMatches = 0;
        for (const phrase of hardPhrases) {
          const matchedField = fieldMatchesPhrase(doc, phrase);
          if (!matchedField && matchMode === "all") return;
          if (matchedField) {
            hardPhraseMatches += 1;
            score += 40 * (FIELD_WEIGHTS[matchedField] || 1);
          }
        }
        if (hardPhrases.length && matchMode === "any" && hardPhraseMatches === 0 && matchedCount === 0) return;

        // Soft auto-phrases: boost only (do not exclude). Prefer docs that contain the full phrase.
        let softHits = 0;
        for (const phrase of softPhrases) {
          const matchedField = fieldMatchesPhrase(doc, phrase);
          if (matchedField) {
            softHits += 1;
            score += 55 * (FIELD_WEIGHTS[matchedField] || 1);
          }
        }
        // If user typed multi-word free text and we have soft phrases, prefer requiring
        // either all content tokens (already applied) OR a soft phrase hit when tokens
        // alone would be empty — already handled by positive terms.
        // When multi-word AND produced candidates, boost exact-phrase docs strongly.
        if (softPhrases.length && softHits === 0 && positiveCount >= 2) {
          // mild penalty so non-phrase AND matches rank below true phrase hits
          score *= 0.72;
        }

        relatedPhraseSet.forEach((source, phrase) => {
          const matchedField = fieldMatchesPhrase(doc, { value: phrase, field: "" });
          if (matchedField) {
            score += 28 * (FIELD_WEIGHTS[matchedField] || 1);
            expansionsUsed.push(`${source} → “${phrase}”`);
          }
        });

        // Phrase-only queries (no tokens): keep docs that hit a phrase
        if (!positiveCount && (hardPhrases.length || softPhrases.length)) {
          if (hardPhraseMatches + softHits === 0) return;
        }

        const normalizedQuery = normalizeText(parsed.text.replace(/\w+:/g, "").replace(/-/g, " ").replace(/"/g, ""));
        if (normalizedQuery && doc._fields.filename.includes(normalizedQuery)) score += 120;
        if (positiveCount && matchedCount === positiveCount) score += 25 * positiveCount;
        const snippet = makeSnippet(doc, normalizedNeedles);
        output.push({
          review_id: doc.review_id,
          queue_number: doc.queue_number,
          score: Math.round(score * 100) / 100,
          matched_field: snippet.field,
          snippet: snippet.text
        });
      });

      output.sort((a, b) => b.score - a.score || a.queue_number - b.queue_number);
      return {
        total: output.length,
        results: output,
        expansions: [...new Set(expansionsUsed)].slice(0, 20),
        parsed
      };
    }
  }

  function makeSnippet(doc, needles) {
    const fields = ["mario_notes", "ai_note", "ocr_text", "transcript_text", "filename", "path"];
    const normalizedNeedles = needles.map(normalizeText).filter(Boolean);
    let best = null;
    fields.forEach((field) => {
      const original = String(doc[field] || "");
      if (!original) return;
      const lower = normalizeText(original);
      let position = Infinity;
      normalizedNeedles.forEach((needle) => {
        const found = lower.indexOf(needle);
        if (found >= 0) position = Math.min(position, found);
      });
      if (position !== Infinity && (!best || position < best.position || (position === best.position && FIELD_WEIGHTS[field] > FIELD_WEIGHTS[best.field]))) {
        best = { field, original, position };
      }
    });
    if (!best) {
      const fallbackField = fields.find((field) => String(doc[field] || "").trim()) || "filename";
      return { field: fallbackField, text: String(doc[fallbackField] || "").slice(0, 360) };
    }
    const start = Math.max(0, best.position - 120);
    const end = Math.min(best.original.length, start + 420);
    return {
      field: best.field,
      text: `${start > 0 ? "…" : ""}${best.original.slice(start, end).replace(/\s+/g, " ").trim()}${end < best.original.length ? "…" : ""}`
    };
  }

  function csvEscape(value) {
    const text = String(value == null ? "" : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(rows, columns) {
    const selected = columns || (rows[0] ? Object.keys(rows[0]) : []);
    return [selected.map(csvEscape).join(","), ...rows.map((row) => selected.map((column) => csvEscape(row[column])).join(","))].join("\r\n");
  }

  return {
    FIELD_ALIASES,
    FIELD_WEIGHTS,
    SearchEngine,
    levenshtein,
    normalizeRecord,
    normalizeText,
    parseCsv,
    parseQuery,
    toCsv,
    tokenize,
    truthy
  };
});
