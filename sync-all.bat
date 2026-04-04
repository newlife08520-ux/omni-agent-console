@echo off
echo [1/6] 2026-02-23 to 2026-02-27
call npx tsx server/scripts/sync-orders-normalized.ts 1 --from 2026-02-23 --to 2026-02-27
echo [2/6] 2026-02-28 to 2026-03-04
call npx tsx server/scripts/sync-orders-normalized.ts 1 --from 2026-02-28 --to 2026-03-04
echo [3/6] 2026-02-18 to 2026-02-22
call npx tsx server/scripts/sync-orders-normalized.ts 1 --from 2026-02-18 --to 2026-02-22
echo [4/6] 2026-02-13 to 2026-02-17
call npx tsx server/scripts/sync-orders-normalized.ts 1 --from 2026-02-13 --to 2026-02-17
echo [5/6] 2026-02-08 to 2026-02-12
call npx tsx server/scripts/sync-orders-normalized.ts 1 --from 2026-02-08 --to 2026-02-12
echo [6/6] 2026-02-03 to 2026-02-07
call npx tsx server/scripts/sync-orders-normalized.ts 1 --from 2026-02-03 --to 2026-02-07
echo === DONE ===
pause
