export type TileMark = "unknown" | "absent" | "present" | "correct";

export type GuessRow = {
  word: string;
  marks: TileMark[];
};

export type Recommendation = {
  guess: string;
  possibleAnswer: boolean;
  exact: boolean;
  worstTurns: number;
  expectedTurns: number;
  entropy: number;
  expectedRemaining: number;
  worstBucket: number;
  singletonCount: number;
  splitCount: number;
};

export type RankedCandidate = {
  recommendation: Recommendation;
  solveDepth: number;
};

const ALL_GREEN_CODE = 242;

export function normalizeWord(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidFiveLetterWord(raw: string): boolean {
  return /^[a-z]{5}$/.test(normalizeWord(raw));
}

export async function loadWords(url: string): Promise<string[]> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to load word list: ${url}`);
  }

  const text = await response.text();

  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((word) => word.trim().toLowerCase())
        .filter((word) => /^[a-z]{5}$/.test(word))
    ),
  ].sort();
}

export function markToPatternChar(mark: TileMark): string {
  if (mark === "correct") return "G";
  if (mark === "present") return "Y";
  if (mark === "absent") return "B";
  return "?";
}

export function getPattern(guess: string, answer: string): string {
  const result: string[] = ["B", "B", "B", "B", "B"];
  const remaining: Record<string, number> = {};

  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) {
      result[i] = "G";
    } else {
      remaining[answer[i]] = (remaining[answer[i]] ?? 0) + 1;
    }
  }

  for (let i = 0; i < 5; i++) {
    if (result[i] === "G") continue;

    const letter = guess[i];

    if ((remaining[letter] ?? 0) > 0) {
      result[i] = "Y";
      remaining[letter]--;
    }
  }

  return result.join("");
}

export function getPatternCode(guess: string, answer: string): number {
  const result = [0, 0, 0, 0, 0];
  const remaining: Record<string, number> = {};

  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) {
      result[i] = 2;
    } else {
      remaining[answer[i]] = (remaining[answer[i]] ?? 0) + 1;
    }
  }

  for (let i = 0; i < 5; i++) {
    if (result[i] === 2) continue;

    const letter = guess[i];

    if ((remaining[letter] ?? 0) > 0) {
      result[i] = 1;
      remaining[letter]--;
    }
  }

  return result[0] + result[1] * 3 + result[2] * 9 + result[3] * 27 + result[4] * 81;
}

export function candidateMatchesRow(candidate: string, row: GuessRow): boolean {
  if (!isValidFiveLetterWord(row.word)) return true;

  const pattern = getPattern(row.word, candidate);

  for (let i = 0; i < 5; i++) {
    const mark = row.marks[i];

    if (mark === "unknown") continue;

    const expected = markToPatternChar(mark);

    if (pattern[i] !== expected) {
      return false;
    }
  }

  return true;
}

export function filterCandidates(solutions: string[], rows: GuessRow[]): string[] {
  return solutions.filter((candidate) => {
    for (const row of rows) {
      if (!candidateMatchesRow(candidate, row)) {
        return false;
      }
    }

    return true;
  });
}

export function buildBuckets(guess: string, candidates: string[]): Map<number, string[]> {
  const buckets = new Map<number, string[]>();

  for (const answer of candidates) {
    const code = getPatternCode(guess, answer);
    const bucket = buckets.get(code);

    if (bucket) {
      bucket.push(answer);
    } else {
      buckets.set(code, [answer]);
    }
  }

  return buckets;
}

export function getPartitionStats(guess: string, candidates: string[]) {
  const buckets = buildBuckets(guess, candidates);
  const n = candidates.length;

  let entropy = 0;
  let expectedRemaining = 0;
  let worstBucket = 0;
  let singletonCount = 0;

  for (const bucket of buckets.values()) {
    const count = bucket.length;
    const probability = count / n;

    entropy += -probability * Math.log2(probability);
    expectedRemaining += probability * count;
    worstBucket = Math.max(worstBucket, count);

    if (count === 1) {
      singletonCount++;
    }
  }

  return {
    buckets,
    entropy,
    expectedRemaining,
    worstBucket,
    singletonCount,
    splitCount: buckets.size,
  };
}

export function getPartitionStatsForList(guess: string, candidates: string[]) {
  const buckets = buildBuckets(guess, candidates);
  const n = candidates.length;

  let entropy = 0;
  let expectedRemaining = 0;
  let worstBucket = 0;
  let singletonCount = 0;

  for (const bucket of buckets.values()) {
    const count = bucket.length;
    const probability = count / n;

    entropy += -probability * Math.log2(probability);
    expectedRemaining += probability * count;
    worstBucket = Math.max(worstBucket, count);

    if (count === 1) {
      singletonCount++;
    }
  }

  return {
    buckets,
    entropy,
    expectedRemaining,
    worstBucket,
    singletonCount,
    splitCount: buckets.size,
  };
}

export function estimateTurnsFromBucketSize(size: number): number {
  if (size <= 1) return 1;
  if (size <= 2) return 2;
  if (size <= 6) return 3;
  if (size <= 18) return 4;
  if (size <= 54) return 5;
  return 6;
}

export function analyzeGuessHeuristic(
  guess: string,
  candidates: string[],
  candidateSet: Set<string>
): Recommendation {
  const possibleAnswer = candidateSet.has(guess);

  const {
    buckets,
    entropy,
    expectedRemaining,
    worstBucket,
    singletonCount,
    splitCount,
  } = getPartitionStats(guess, candidates);

  let worstTurns = 0;
  let expectedTurns = 0;

  for (const [code, bucket] of buckets) {
    const solvedNow =
      code === ALL_GREEN_CODE && bucket.length === 1 && bucket[0] === guess;

    const cost = solvedNow ? 1 : 1 + estimateTurnsFromBucketSize(bucket.length);

    worstTurns = Math.max(worstTurns, cost);
    expectedTurns += (bucket.length / candidates.length) * cost;
  }

  return {
    guess,
    possibleAnswer,
    exact: false,
    worstTurns,
    expectedTurns,
    entropy,
    expectedRemaining,
    worstBucket,
    singletonCount,
    splitCount,
  };
}

export function compareRecommendations(a: Recommendation, b: Recommendation): number {
  if (a.worstTurns !== b.worstTurns) return a.worstTurns - b.worstTurns;
  if (a.expectedTurns !== b.expectedTurns) return a.expectedTurns - b.expectedTurns;
  if (a.worstBucket !== b.worstBucket) return a.worstBucket - b.worstBucket;
  if (a.expectedRemaining !== b.expectedRemaining) return a.expectedRemaining - b.expectedRemaining;
  if (b.entropy !== a.entropy) return b.entropy - a.entropy;
  if (b.singletonCount !== a.singletonCount) return b.singletonCount - a.singletonCount;
  if (b.splitCount !== a.splitCount) return b.splitCount - a.splitCount;

  if (b.possibleAnswer !== a.possibleAnswer) {
    return Number(b.possibleAnswer) - Number(a.possibleAnswer);
  }

  return a.guess.localeCompare(b.guess);
}

export function insertIntoTop(
  topList: Recommendation[],
  item: Recommendation,
  limit: number
): void {
  if (topList.length === 0) {
    topList.push(item);
    return;
  }

  let inserted = false;

  for (let i = 0; i < topList.length; i++) {
    if (compareRecommendations(item, topList[i]) < 0) {
      topList.splice(i, 0, item);
      inserted = true;
      break;
    }
  }

  if (!inserted && topList.length < limit) {
    topList.push(item);
  }

  if (topList.length > limit) {
    topList.length = limit;
  }
}