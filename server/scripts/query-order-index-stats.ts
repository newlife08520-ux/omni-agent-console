/** npx tsx server/scripts/query-order-index-stats.ts [brand_id] */
import { getOrderIndexStats } from "../order-index";

const bid = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
console.log(JSON.stringify(getOrderIndexStats(bid), null, 2));
