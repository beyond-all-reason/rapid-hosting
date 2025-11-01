Rapid hosting
=============

Ansible playbook for setting up alternative Spring RTS rapid hosting server.

Testing
-------

Without acquiring of the certificate from Let's Encrypt, it's possible to test the playbook using containers. Below is example testing execution.

```sh
podman build --build-arg=SSH_PUB_KEY="$(cat ~/.ssh/id_ed25519.pub)" \
  -f testsrv.Dockerfile -t rapid-hosting-testsrv
podman run --publish-all --detach --name testsrv rapid-hosting-testsrv
ansible-playbook -i inventory.yaml \
  -e ansible_ssh_port=$(podman port testsrv 22 | cut -d: -f2) \
  -e repos_address_override=localhost:$(podman port testsrv 443 | cut -d: -f2) \
  -l testsrv play.yaml
podman exec testsrv systemctl start --wait update-rapid-repo@chobby.service
PRD_RAPID_REPO_MASTER=https://localhost:$(podman port testsrv 443 | cut -d: -f2)/repos.gz \
  PRD_RAPID_USE_STREAMER=false \
  PRD_DISABLE_CERT_CHECK=true \
  pr-downloader --filesystem-writepath /tmp/prd --download-game chobby:test
podman stop testsrv
podman rm testsrv
```

Deploy Key Management
---------------------

The deploy user SSH key for GitHub Actions is managed by Ansible. The key is placed in `rapid_repos/files/github-actions.pub` and installed with a command restriction:

```
command="sudo update-rapid-repo \"$SSH_ORIGINAL_COMMAND\""
```

This allows the deploy workflow to trigger builds with up to 4 arguments (repo, branch, rapid tag, game version).

Example Deploy Command
----------------------

From your CI/CD workflow or manually:

```
ssh deploy@host update-rapid-repo <repo> <branch> <rapid_tag> <game_version>
```

All arguments are optional except `<repo>`.

Configuring Branch Builds
-------------------------

Every repo definition in your inventory retains a primary `branch`, which the periodic timer builds. To allow ad hoc builds for additional branches, add a `branches` list to the repo entry. The primary `branch` must also appear in that list. If the list is omitted, the role automatically limits builds to the primary branch. When triggering a build manually (for example from CI) pass the desired branch as the second argument to `update-rapid-repo`:

```
ssh deploy@host update-rapid-repo <repo> <branch>
```

Only the branches listed in the repo configuration are accepted.
