export class DaytonaDisabledError extends Error {
  constructor() {
    super("Daytona is not configured. Set DAYTONA_API_KEY to enable the isolated computer.");
    this.name = "DaytonaDisabledError";
  }
}

export class DaytonaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaytonaInputError";
  }
}
