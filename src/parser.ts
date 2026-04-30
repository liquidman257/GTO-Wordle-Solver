import type { StrategyTree } from "./types";

const WORD_RE = /^[a-z]{5}$/;
const FEEDBACK_RE = /^[BGY]{5}\d+$/;
const TOKEN_RE = /\S+/g;

const STEP = 13;
const FEEDBACK_OFFSET = 6;

type Token = [column: number, value: string];

function tokenizeLine(line: string): Token[] {
  const out: Token[] = [];
  let match: RegExpExecArray | null;

  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    out.push([match.index, match[0]]);
  }

  return out;
}

function wordDepth(column: number): number {
  if (column < 0 || column % STEP !== 0) {
    throw new Error(`Invalid word column ${column}. Expected ${STEP}n.`);
  }

  return column / STEP + 1;
}

function feedbackDepth(column: number): number {
  if (column < FEEDBACK_OFFSET || (column - FEEDBACK_OFFSET) % STEP !== 0) {
    throw new Error(`Invalid feedback column ${column}. Expected ${FEEDBACK_OFFSET}+${STEP}n.`);
  }

  return (column - FEEDBACK_OFFSET) / STEP + 1;
}

export function parseStrategySheet(text: string): StrategyTree {
  const nodes: StrategyTree["nodes"] = {};
  const nodeKeyToId = new Map<string, string>();
  const currentNode = new Map<number, string>();
  const currentPath = new Map<number, Array<[string, string]>>();
  let rootId = "";

  function getOrCreateNode(word: string, depth: number, pathKey: Array<[string, string]>): string {
    const key = JSON.stringify(pathKey);
    const existing = nodeKeyToId.get(key);

    if (existing) {
      return existing;
    }

    const id = `n${Object.keys(nodes).length}`;
    nodeKeyToId.set(key, id);
    nodes[id] = {
      w: word.toUpperCase(),
      d: depth,
      c: {}
    };

    if (depth === 1 && !rootId) {
      rootId = id;
    }

    return id;
  }

  const lines = text.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];

    if (!rawLine.trim()) {
      continue;
    }

    const tokens = tokenizeLine(rawLine);
    let i = 0;

    while (i < tokens.length) {
      const [column, token] = tokens[i];

      if (WORD_RE.test(token)) {
        const depth = wordDepth(column);

        if (depth !== 1 && !currentNode.has(depth - 1)) {
          throw new Error(`Line ${lineIndex + 1}: word "${token}" appeared without an active parent.`);
        }

        if (depth === 1) {
          const pathKey: Array<[string, string]> = [["ROOT", token.toUpperCase()]];
          const nodeId = getOrCreateNode(token, depth, pathKey);

          currentNode.clear();
          currentPath.clear();
          currentNode.set(1, nodeId);
          currentPath.set(1, pathKey);
        }

        i += 1;
        continue;
      }

      if (!FEEDBACK_RE.test(token)) {
        throw new Error(`Line ${lineIndex + 1}: unknown token "${token}".`);
      }

      const depth = feedbackDepth(column);
      const feedback = token.slice(0, 5).toUpperCase();
      const turn = Number(token.slice(5));

      if (!currentNode.has(depth)) {
        throw new Error(`Line ${lineIndex + 1}: feedback "${token}" has no active guess at depth ${depth}.`);
      }

      for (const d of [...currentNode.keys()]) {
        if (d > depth) {
          currentNode.delete(d);
          currentPath.delete(d);
        }
      }

      const parentId = currentNode.get(depth);
      const parentPath = currentPath.get(depth);

      if (!parentId || !parentPath) {
        throw new Error(`Line ${lineIndex + 1}: internal parser state error.`);
      }

      if (feedback === "GGGGG") {
        nodes[parentId].c[feedback] = {
          term: true,
          turn
        };

        i += 1;
        continue;
      }

      if (i + 1 >= tokens.length) {
        throw new Error(`Line ${lineIndex + 1}: feedback "${token}" needs a next guess word.`);
      }

      const [nextColumn, nextWord] = tokens[i + 1];

      if (!WORD_RE.test(nextWord)) {
        throw new Error(`Line ${lineIndex + 1}: expected next guess after "${token}", got "${nextWord}".`);
      }

      const childDepth = wordDepth(nextColumn);

      if (childDepth != depth + 1) {
        throw new Error(
          `Line ${lineIndex + 1}: word "${nextWord}" is at depth ${childDepth}; expected ${depth + 1}.`
        );
      }

      const childPath: Array<[string, string]> = [...parentPath, [feedback, nextWord.toUpperCase()]];
      const childId = getOrCreateNode(nextWord, childDepth, childPath);

      nodes[parentId].c[feedback] = {
        to: childId,
        turn
      };

      currentNode.set(childDepth, childId);
      currentPath.set(childDepth, childPath);

      i += 2;
    }
  }

  if (!rootId) {
    throw new Error("No root word was found in this strategy file.");
  }

  return {
    rootId,
    nodes
  };
}
