/// <reference lib="webworker" />

import {
  type InspectStats,
  type RankedCandidate,
  type Recommendation,
  analyzeGuessHeuristic,
  buildBuckets,
  compareRecommendations,
  estimateTurnsFromBucketSize,
  getPartitionStats,
  insertIntoTop,
} from "./wordle";

type HeuristicStartMessage = {
  type: "heuristic";
  candidates: string[];
  guesses: string[];
  topN: number;
};

type RefineStartMessage = {
  type: "refine";
  candidates: string[];
  guesses: string[];
  rootGuess: string;
};

type InspectStartMessage = {
  type: "inspect";
  candidates: string[];
  guesses: string[];
  guess: string;
};

type WorkerStartMessage =
  | HeuristicStartMessage
  | RefineStartMessage
  | InspectStartMessage;

type HeuristicProgressMessage = {
  type: "heuristic_progress";
  processed: number;
  total: number;
  topRecommendations: Recommendation[];
};

type HeuristicDoneMessage = {
  type: "heuristic_done";
  topRecommendations: Recommendation[];
};

type RefineProgressMessage = {
  type: "refine_progress";
  rootGuess: string;
  processedBuckets: number;
  totalBuckets: number;
  recommendation: Recommendation;
  rankedCandidates: RankedCandidate[];
};

type RefineDoneMessage = {
  type: "refine_done";
  rootGuess: string;
  recommendation: Recommendation;
  rankedCandidates: RankedCandidate[];
};

type InspectDoneMessage = {
  type: "inspect_done";
  stats: InspectStats;
};

type WorkerErrorMessage = {
  type: "error";
  error: string;
};

const ctx = self as DedicatedWorkerGlobalScope;

const HEURISTIC_CHUNK = 128;
const REFINE_PROGRESS_EVERY = 4;

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function computeBestChildHeuristic(
  bucketCandidates: string[],
  guesses: string[]
): Recommendation {
  const candidateSet = new Set(bucketCandidates);
  let best: Recommendation | null = null;

  for (const guess of guesses) {
    const current = analyzeGuessHeuristic(guess, bucketCandidates, candidateSet);

    if (best === null || compareRecommendations(current, best) < 0) {
      best = current;
    }
  }

  return (
    best ?? {
      guess: bucketCandidates[0],
      possibleAnswer: true,
      exact: false,
      worstTurns: 1,
      expectedTurns: 1,
      entropy: 0,
      expectedRemaining: 1,
      worstBucket: 1,
      singletonCount: 1,
      splitCount: 1,
    }
  );
}

function buildRankedCandidates(
  candidates: string[],
  depthMap: Map<string, number>
): RankedCandidate[] {
  return candidates
    .map((word) => {
      const depth = depthMap.get(word) ?? Number.POSITIVE_INFINITY;

      return {
        recommendation: {
          guess: word,
          possibleAnswer: true,
          exact: false,
          worstTurns: depth,
          expectedTurns: depth,
          entropy: 0,
          expectedRemaining: 0,
          worstBucket: 0,
          singletonCount: 0,
          splitCount: 0,
        },
        solveDepth: depth,
      };
    })
    .sort((a, b) => {
      if (a.solveDepth !== b.solveDepth) {
        return a.solveDepth - b.solveDepth;
      }

      return a.recommendation.guess.localeCompare(b.recommendation.guess);
    });
}

function refineRootGuess(
  candidates: string[],
  guesses: string[],
  rootGuess: string,
  onProgress?: (
    recommendation: Recommendation,
    rankedCandidates: RankedCandidate[],
    processedBuckets: number,
    totalBuckets: number
  ) => void
): {
  recommendation: Recommendation;
  rankedCandidates: RankedCandidate[];
} {
  const rootHeuristic = analyzeGuessHeuristic(rootGuess, candidates, new Set(candidates));
  const buckets = [...buildBuckets(rootGuess, candidates).entries()].sort(
    (a, b) => b[1].length - a[1].length
  );

  const depthMap = new Map<string, number>();
  const totalCandidates = candidates.length;

  let processedBuckets = 0;
  let processedWeight = 0;
  let rootWorst = 0;
  let rootExpected = 0;

  for (const [code, bucket] of buckets) {
    const solvedByRoot =
      code === 242 && bucket.length === 1 && bucket[0] === rootGuess;

    if (solvedByRoot) {
      depthMap.set(rootGuess, 1);
      rootWorst = Math.max(rootWorst, 1);
      rootExpected += 1 / totalCandidates;
      processedBuckets++;
      processedWeight += bucket.length / totalCandidates;
    } else {
      const childBest = computeBestChildHeuristic(bucket, guesses);
      const childBuckets = [...buildBuckets(childBest.guess, bucket).entries()];

      let bucketWorst = 0;
      let bucketExpected = 0;

      for (const [childCode, childBucket] of childBuckets) {
        const solvedByChild =
          childCode === 242 &&
          childBucket.length === 1 &&
          childBucket[0] === childBest.guess;

        const depth = solvedByChild
          ? 2
          : 2 + estimateTurnsFromBucketSize(childBucket.length);

        for (const word of childBucket) {
          depthMap.set(word, depth);
        }

        bucketWorst = Math.max(bucketWorst, depth);
        bucketExpected += (childBucket.length / bucket.length) * depth;
      }

      rootWorst = Math.max(rootWorst, bucketWorst);
      rootExpected += (bucket.length / totalCandidates) * bucketExpected;
      processedBuckets++;
      processedWeight += bucket.length / totalCandidates;
    }

    if (onProgress && (processedBuckets % REFINE_PROGRESS_EVERY === 0 || processedBuckets === buckets.length)) {
      const remainingWeight = Math.max(0, 1 - processedWeight);

      onProgress(
        {
          ...rootHeuristic,
          worstTurns: Math.max(rootWorst, rootHeuristic.worstTurns),
          expectedTurns: rootExpected + remainingWeight * rootHeuristic.expectedTurns,
        },
        buildRankedCandidates(candidates, depthMap),
        processedBuckets,
        buckets.length
      );
    }
  }

  return {
    recommendation: {
      ...rootHeuristic,
      worstTurns: rootWorst,
      expectedTurns: rootExpected,
    },
    rankedCandidates: buildRankedCandidates(candidates, depthMap),
  };
}

async function runHeuristicJob(message: HeuristicStartMessage): Promise<void> {
  const { candidates, guesses, topN } = message;
  const candidateSet = new Set(candidates);
  const topList: Recommendation[] = [];

  for (let start = 0; start < guesses.length; start += HEURISTIC_CHUNK) {
    const end = Math.min(guesses.length, start + HEURISTIC_CHUNK);

    for (let i = start; i < end; i++) {
      const guess = guesses[i];
      const rec = analyzeGuessHeuristic(guess, candidates, candidateSet);
      insertIntoTop(topList, rec, topN);
    }

    ctx.postMessage({
      type: "heuristic_progress",
      processed: end,
      total: guesses.length,
      topRecommendations: [...topList],
    } satisfies HeuristicProgressMessage);

    await nextTick();
  }

  ctx.postMessage({
    type: "heuristic_done",
    topRecommendations: [...topList],
  } satisfies HeuristicDoneMessage);
}

async function runRefineJob(message: RefineStartMessage): Promise<void> {
  const { candidates, guesses, rootGuess } = message;

  const result = refineRootGuess(
    candidates,
    guesses,
    rootGuess,
    (recommendation, rankedCandidates, processedBuckets, totalBuckets) => {
      ctx.postMessage({
        type: "refine_progress",
        rootGuess,
        processedBuckets,
        totalBuckets,
        recommendation,
        rankedCandidates,
      } satisfies RefineProgressMessage);
    }
  );

  await nextTick();

  ctx.postMessage({
    type: "refine_done",
    rootGuess,
    recommendation: result.recommendation,
    rankedCandidates: result.rankedCandidates,
  } satisfies RefineDoneMessage);
}

async function runInspectJob(message: InspectStartMessage): Promise<void> {
  const { candidates, guesses, guess } = message;

  const stats = getPartitionStats(guess, candidates);
  const heuristic = analyzeGuessHeuristic(guess, candidates, new Set(candidates));
  const refined = refineRootGuess(candidates, guesses, guess);

  const topBucketSizes = [...stats.buckets.values()]
    .map((bucket) => bucket.length)
    .sort((a, b) => b - a)
    .slice(0, 10);

  const result: InspectStats = {
    guess,
    candidateCount: candidates.length,
    possibleAnswer: new Set(candidates).has(guess),
    entropy: stats.entropy,
    expectedRemaining: stats.expectedRemaining,
    worstBucket: stats.worstBucket,
    singletonCount: stats.singletonCount,
    splitCount: stats.splitCount,
    heuristicWorst: heuristic.worstTurns,
    heuristicExpected: heuristic.expectedTurns,
    refinedWorst: refined.recommendation.worstTurns,
    refinedExpected: refined.recommendation.expectedTurns,
    topBucketSizes,
  };

  ctx.postMessage({
    type: "inspect_done",
    stats: result,
  } satisfies InspectDoneMessage);
}

ctx.onmessage = (event: MessageEvent<WorkerStartMessage>) => {
  const message = event.data;

  if (message.type === "heuristic") {
    void runHeuristicJob(message).catch((error: unknown) => {
      ctx.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerErrorMessage);
    });
    return;
  }

  if (message.type === "refine") {
    void runRefineJob(message).catch((error: unknown) => {
      ctx.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerErrorMessage);
    });
    return;
  }

  if (message.type === "inspect") {
    void runInspectJob(message).catch((error: unknown) => {
      ctx.postMessage({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerErrorMessage);
    });
  }
};

export {};