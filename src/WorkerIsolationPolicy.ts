const repositoryCredentialNamePattern =
  /^(?:gh|github|gitlab|bitbucket|azure_devops)(?:_|$)|^(?:agent_pat|git_token|repo_token|git_askpass|ssh_askpass|ssh_auth_sock|ci_job_token)$|^git_(?:config|credential|ssh)(?:_|$)/i;

const protectedWorkerMaterialPattern =
  /(?:"(?:gh_token|github_token|git_token|repo_token|agent_pat|password|secret|workerConfiguration|authorizedTasks|promptTemplates)"\s*:|\b(?:GH_TOKEN|GITHUB_TOKEN|GIT_TOKEN|REPO_TOKEN|AGENT_PAT|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+))\s*=|\bAuthorization\s*:\s*(?:Bearer|Basic)\s+|\b(?:credential\.helper|http\..*\.extraheader)\s*=|https:\/\/[^\s/@:]+:[^\s/@]+@)/i;

/** Whether an environment name grants repository authority and must stay outside agents. */
export const isRepositoryCredentialName = (name: string): boolean =>
  repositoryCredentialNamePattern.test(name);

/** Whether retained text contains credentials or central worker configuration. */
export const containsProtectedWorkerMaterial = (content: string): boolean =>
  protectedWorkerMaterialPattern.test(content);

/** Repository-authority names declared by a dotenv-style file. */
export const repositoryCredentialNamesInEnvironmentFile = (
  content: string,
): readonly string[] =>
  content
    .split(/\r?\n/)
    .map(
      (line) =>
        line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1],
    )
    .filter((name): name is string =>
      name === undefined ? false : isRepositoryCredentialName(name),
    );
