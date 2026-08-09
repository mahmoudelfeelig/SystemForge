import { candidateScenario, type Scenario } from "@systemforge/contracts";

const publicRunScenario = (scenario: Scenario): Scenario => {
  const publicScenario = candidateScenario(scenario);
  return {
    ...publicScenario,
    requirements: publicScenario.requirements.filter(
      (requirement) =>
        requirement.visibility !== "derived" ||
        requirement.owner !== "candidate",
    ),
  };
};

export const runMatchesSharedScenario = (
  submitted: Scenario,
  shared: Scenario,
): boolean => {
  const candidateRequirementsAllowed =
    shared.interview?.allowCandidateRequirements === true;
  if (
    !candidateRequirementsAllowed &&
    submitted.requirements.some(
      (requirement) =>
        requirement.visibility === "derived" &&
        requirement.owner === "candidate",
    )
  )
    return false;
  return (
    JSON.stringify(publicRunScenario(submitted)) ===
    JSON.stringify(publicRunScenario(shared))
  );
};

export const mergeAllowedCandidateRequirements = (
  shared: Scenario,
  submitted: Scenario,
): Scenario => {
  if (shared.interview?.allowCandidateRequirements !== true) return shared;
  const existingIds = new Set(
    shared.requirements.map((requirement) => requirement.id),
  );
  const candidateRequirements = submitted.requirements.filter(
    (requirement) =>
      requirement.visibility === "derived" &&
      requirement.owner === "candidate" &&
      !existingIds.has(requirement.id),
  );
  if (candidateRequirements.length === 0) return shared;
  return {
    ...shared,
    requirements: [...shared.requirements, ...candidateRequirements],
  };
};
