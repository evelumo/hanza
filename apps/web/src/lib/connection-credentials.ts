/** The id of the "Credentials" section of a Connection's page, where its credentials are replaced. */
export const CREDENTIALS_SECTION_ID = 'credentials'

/** Straight to that form, for a place that says a Connection needs new credentials. */
export const credentialsFormHref = (connectionId: string) => `/connections/${connectionId}#${CREDENTIALS_SECTION_ID}`
