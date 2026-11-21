# sokoban-solver-20261121

A push-optimal Sokoban solver for make.fun's `sokoban-solver-01-run-20261121`:
one program answers a whole set of 5 drawn levels in about a second, at the
push-optimal count P\* on every level of the practice set (score 1,000,000).

How it works: each level is a 1-wide hallway with 1–4 rooms off it, one door
each, and a box pushed out of a room can never return — so every room is an
independent subproblem and the level optimum is the sum of the room optima.
Each room is solved with a push-based A\* (player-reachability BFS between
pushes, a wall-aware assignment heuristic, and sound deadlock pruning:
dead squares, wall-only corners, frozen boxes, 2×2 blocks, and closed
wall segments), then the room solutions are stitched together with walks
along the hallway. Deterministic: fixed direction order, no clock, no
randomness.

Run it: `MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=<output> node main.ts`

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/risman18/sokoban-solver-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/risman18/sokoban-solver-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Entered on [make.fun](https://make.fun/?ref=7trfcnag&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards
