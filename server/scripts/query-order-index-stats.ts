/** npx tsx server/scripts/query-order-index-stats.ts [brand_id] */
import { getOrderIndexStats } from "../order-index";

const bid = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
const s = getOrderIndexStats(bid);
console.log(JSON.stringify(s, null, 2));
console.log(
  "[stats:order-index] Phase24: order_created_at_missing=",
  s.order_created_at_missing_count,
  "min=",
  s.order_created_at_min,
  "max=",
  s.order_created_at_max
);
