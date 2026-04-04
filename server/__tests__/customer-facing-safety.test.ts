import { describe, it, expect } from "vitest";
import { findCustomerFacingRawLeak } from "../order-reply-utils";

describe("findCustomerFacingRawLeak", () => {
  it("正常中文回覆無 leak", () => {
    expect(findCustomerFacingRawLeak("您的訂單已出貨，物流編號 12345")).toBeNull();
  });

  it("包含 pending 被偵測", () => {
    const result = findCustomerFacingRawLeak("您的付款狀態是 pending，請稍候");
    expect(result).not.toBeNull();
  });

  it("包含 credit_card 被偵測", () => {
    const result = findCustomerFacingRawLeak("付款方式：credit_card");
    expect(result).not.toBeNull();
  });

  it("包含 to_store 被偵測", () => {
    const result = findCustomerFacingRawLeak("配送方式 to_store 超商取貨");
    expect(result).not.toBeNull();
  });
});
