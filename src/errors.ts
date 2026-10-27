/** 所有业务异常的基类：消息直接展示给 agent，所以要写得能指导下一步操作 */
export class NoyError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "NoyError";
  }
}

/** `{"status":"login"}`：NOY_SESSION 缺失或已失效 */
export class NoyAuthError extends NoyError {
  constructor(message = "需要登录：NOY_SESSION 缺失或已失效") {
    super(message);
    this.name = "NoyAuthError";
  }
}

/** 接口返回了非 ok 的业务状态 */
export class NoyApiError extends NoyError {
  constructor(
    message: string,
    readonly status: unknown,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "NoyApiError";
  }
}
