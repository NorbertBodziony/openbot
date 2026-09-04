// The status a Team API route wants the caller to read, carried on the throw.
//
// One definition, deliberately alone in a file. The router's single catch classifies by `instanceof`,
// so a second copy of this class anywhere would make that check silently false: every 400 a route
// raises would become a 500 "Request failed." with the message replaced and the cause logged as an
// unexpected error. Nothing in the route table test can see that. It does not live in
// `team-api-server.ts` because the route modules and the request helpers both throw it, and importing
// it back from the server would put a class declaration inside an import cycle.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
