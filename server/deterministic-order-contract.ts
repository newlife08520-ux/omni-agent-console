/** Phase 2.7：order deterministic 可版本化契約 */
export const DETERMINISTIC_ORDER_CONTRACT_VERSION = 1 as const;
export const DETERMINISTIC_ORDER_DOMAIN = "order" as const;

export function orderDeterministicContractFields(): {
  deterministic_contract_version: number;
  deterministic_domain: string;
} {
  return {
    deterministic_contract_version: DETERMINISTIC_ORDER_CONTRACT_VERSION,
    deterministic_domain: DETERMINISTIC_ORDER_DOMAIN,
  };
}

export function isValidOrderDeterministicPayload(pr: Record<string, unknown>): boolean {
  return (
    pr.deterministic_skip_llm === true &&
    typeof pr.deterministic_customer_reply === "string" &&
    pr.deterministic_customer_reply.trim().length > 0 &&
    Number(pr.deterministic_contract_version) === DETERMINISTIC_ORDER_CONTRACT_VERSION &&
    pr.deterministic_domain === DETERMINISTIC_ORDER_DOMAIN
  );
}
