/** Fictional display fixtures. Never used by the authenticated API client or presented as chain observations. */
export const demoInternships = [
  { id: "openfield", title: "Build an open-source analytics kit", organization: "Openfield Studio", area: "Frontend engineering", description: "Turn a small dataset into a useful, accessible dashboard. Work in a fictional public repository and review each milestone independently.",
    milestones: [
      { title: "Map the data model", status: "Verified", amount: "300", evidence: "Schema and requirements review", verification: "Sample independent verification passed" },
      { title: "Ship the dashboard", status: "Submitted", amount: "600", evidence: "GitHub pull request awaiting review", verification: "Sample verification pending" },
      { title: "Document the handover", status: "Assigned", amount: "300", evidence: "No submission yet", verification: "Awaiting evidence" },
    ] },
  { id: "smallhours", title: "Make developer docs more useful", organization: "Small Hours Lab", area: "Developer experience", description: "Create an approachable quick-start guide and improve the example project. This is a fictional internship for exploring the interface.",
    milestones: [
      { title: "Write the quick-start guide", status: "Assigned", amount: "400", evidence: "No submission yet", verification: "Awaiting evidence" },
      { title: "Improve the example project", status: "Funded", amount: "400", evidence: "No submission yet", verification: "Awaiting assignment" },
    ] },
] as const;
