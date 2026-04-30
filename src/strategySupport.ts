import { parseStrategySheet } from "./parser";
import type {
  FeedbackColor,
  FeedbackPattern,
  StrategyBranchPreview,
  StrategyEntry,
  StrategyRowInput,
  StrategyStatsRow,
  StrategyTree,
  StrategyTreeCache,
  StrategyWalkResult
} from "./types";

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out;
}

function toNumberMaybe(value: string): string | number {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

export async function loadStrategyEntries(): Promise<StrategyEntry[]> {
  const response = await fetch("/api/strategies", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load strategies: HTTP ${response.status}`);
  }

  const entries = (await response.json()) as StrategyEntry[];
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadStrategyStatsCsv(url = "/strategy_stats.csv"): Promise<StrategyStatsRow[]> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load strategy stats: HTTP ${response.status}`);
  }

  const text = await response.text();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]).map((value) => value.trim());
  const rows: StrategyStatsRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row: Record<string, string | number | undefined> = {};

    for (let column = 0; column < header.length; column++) {
      row[header[column]] = toNumberMaybe(cells[column] ?? "");
    }

    if (typeof row.starting_word !== "string" || typeof row.file !== "string") {
      continue;
    }

    row.starting_word = row.starting_word.toUpperCase();
    rows.push(row as StrategyStatsRow);
  }

  return rows;
}

export function buildStrategyStatsMap(rows: StrategyStatsRow[]): Map<string, StrategyStatsRow> {
  const map = new Map<string, StrategyStatsRow>();

  for (const row of rows) {
    map.set(row.starting_word.toUpperCase(), row);
  }

  return map;
}

export function feedbackLocksToPattern(locks: Array<FeedbackColor | null>): FeedbackPattern | null {
  if (locks.length !== 5 || locks.some((value) => value === null)) {
    return null;
  }

  return locks.join("") as FeedbackPattern;
}

export function normalizePlayedRows(
  rows: Array<{ word: string; locks?: Array<FeedbackColor | null>; pattern?: string | null }>
): StrategyRowInput[] {
  return rows
    .map((row) => ({
      word: row.word.trim().toUpperCase(),
      pattern: row.pattern
        ? row.pattern.toUpperCase()
        : row.locks
          ? feedbackLocksToPattern(row.locks)
          : null
    }))
    .filter((row) => /^[A-Z]{5}$/.test(row.word));
}

export function findStrategyEntryForWord(firstGuess: string, entries: StrategyEntry[]): StrategyEntry | null {
  const target = firstGuess.trim().toUpperCase();

  return (
    entries.find((entry) => entry.name.toUpperCase() === target) ??
    entries.find((entry) => entry.file.replace(/\.txt$/i, "").toUpperCase() === target) ??
    null
  );
}

export async function loadStrategyTreeForWord(
  firstGuess: string,
  entries: StrategyEntry[],
  cache: StrategyTreeCache
): Promise<StrategyTree | null> {
  const entry = findStrategyEntryForWord(firstGuess, entries);
  if (!entry) {
    return null;
  }

  const key = entry.file.toLowerCase();
  const cached = cache.get(key);

  if (cached instanceof Promise) {
    return cached;
  }

  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const response = await fetch(`/strategies/${encodeURIComponent(entry.file)}`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Could not load strategy file ${entry.file}: HTTP ${response.status}`);
    }

    const raw = await response.text();
    return parseStrategySheet(raw);
  })()
    .then((tree) => {
      cache.set(key, tree);
      return tree;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });

  cache.set(key, promise);
  return promise;
}

function childToPreview(
  tree: StrategyTree,
  pattern: string,
  child: StrategyTree["nodes"][string]["c"][string]
): StrategyBranchPreview {
  if ("term" in child && child.term) {
    return {
      pattern,
      nextWord: null,
      turn: child.turn,
      terminal: true
    };
  }

  return {
    pattern,
    nextWord: tree.nodes[child.to]?.w ?? null,
    turn: child.turn,
    terminal: false
  };
}

function partialPatternMatches(targetPattern: string, partialPattern: string | null): boolean {
  if (!partialPattern) {
    return true;
  }

  for (let i = 0; i < 5; i++) {
    const value = partialPattern[i];
    if (value && /[BGY]/.test(value) && value !== targetPattern[i]) {
      return false;
    }
  }

  return true;
}

export function walkStrategyTree(
  tree: StrategyTree,
  playedRowsInput: StrategyRowInput[],
  statsRow: StrategyStatsRow | null = null
): StrategyWalkResult {
  const playedRows = normalizePlayedRows(playedRowsInput);

  if (playedRows.length === 0) {
    const root = tree.nodes[tree.rootId];
    return {
      source: "tree",
      rootWord: root?.w ?? null,
      matchedDepth: 0,
      nextWord: root?.w ?? null,
      terminal: false,
      error: root ? null : "Missing root node.",
      branchOptions: root
        ? Object.entries(root.c)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([pattern, child]) => childToPreview(tree, pattern, child))
        : [],
      stats: statsRow
    };
  }

  const root = tree.nodes[tree.rootId];
  if (!root) {
    return {
      source: "none",
      rootWord: null,
      matchedDepth: 0,
      nextWord: null,
      terminal: false,
      error: "Missing root node.",
      branchOptions: [],
      stats: statsRow
    };
  }

  let currentNodeId = tree.rootId;
  let matchedDepth = 0;

  for (let index = 0; index < playedRows.length; index++) {
    const played = playedRows[index];
    const node = tree.nodes[currentNodeId];

    if (!node) {
      return {
        source: "none",
        rootWord: root.w,
        matchedDepth,
        nextWord: null,
        terminal: false,
        error: `Missing strategy node ${currentNodeId}.`,
        branchOptions: [],
        stats: statsRow
      };
    }

    if (node.w !== played.word) {
      return {
        source: "none",
        rootWord: root.w,
        matchedDepth,
        nextWord: null,
        terminal: false,
        error: `Tree expected ${node.w} on row ${index + 1}, but board has ${played.word}.`,
        branchOptions: [],
        stats: statsRow
      };
    }

    matchedDepth = index + 1;

    if (!played.pattern) {
      return {
        source: "tree",
        rootWord: root.w,
        matchedDepth,
        nextWord: node.w,
        terminal: false,
        error: null,
        branchOptions: Object.entries(node.c)
          .filter(([pattern]) => partialPatternMatches(pattern, played.pattern))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([pattern, child]) => childToPreview(tree, pattern, child)),
        stats: statsRow
      };
    }

    const child = node.c[played.pattern];
    if (!child) {
      return {
        source: "none",
        rootWord: root.w,
        matchedDepth: matchedDepth - 1,
        nextWord: null,
        terminal: false,
        error: `No branch for ${node.w} with pattern ${played.pattern}.`,
        branchOptions: Object.entries(node.c)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([pattern, candidate]) => childToPreview(tree, pattern, candidate)),
        stats: statsRow
      };
    }

    if ("term" in child && child.term) {
      return {
        source: "tree",
        rootWord: root.w,
        matchedDepth,
        nextWord: null,
        terminal: true,
        error: null,
        branchOptions: [],
        stats: statsRow
      };
    }

    currentNodeId = child.to;
  }

  const nextNode = tree.nodes[currentNodeId];
  if (!nextNode) {
    return {
      source: "none",
      rootWord: root.w,
      matchedDepth,
      nextWord: null,
      terminal: false,
      error: `Missing next strategy node ${currentNodeId}.`,
      branchOptions: [],
      stats: statsRow
    };
  }

  return {
    source: "tree",
    rootWord: root.w,
    matchedDepth,
    nextWord: nextNode.w,
    terminal: false,
    error: null,
    branchOptions: Object.entries(nextNode.c)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pattern, child]) => childToPreview(tree, pattern, child)),
    stats: statsRow
  };
}

export function getOpeningRecommendationsFromStats(rows: StrategyStatsRow[], limit = 30): StrategyStatsRow[] {
  return [...rows]
    .sort((a, b) => {
      const expectedDelta = Number(a.expected_guesses) - Number(b.expected_guesses);
      if (expectedDelta !== 0) return expectedDelta;

      const maxDelta = Number(a.maximum_guesses) - Number(b.maximum_guesses);
      if (maxDelta !== 0) return maxDelta;

      const minDelta = Number(a.minimum_guesses) - Number(b.minimum_guesses);
      if (minDelta !== 0) return minDelta;

      return a.starting_word.localeCompare(b.starting_word);
    })
    .slice(0, limit);
}
