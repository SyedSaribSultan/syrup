/**
 * An error whose message is written for the person using the app (a bad repository URL, a skill too large, a
 * sandbox that could not start). Route handlers return it as is, with its status; every other error is internal.
 */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "UserError"
  }
}
