// Finder appends a space and copy number when a PST is duplicated, for example
// Exchange.001.pst 2. It is still a PST and readpst can process it normally.
export const isPstFilename = (name: string) => /\.pst(?:\s+\d+)?$/i.test(name);
