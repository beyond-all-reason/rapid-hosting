Rapid hosting
=============

[Ansible](<https://en.wikipedia.org/wiki/Ansible_(software)>) playbook for setting up the
Beyond All Reason rapid hosting server.

The server serves rapid repos with Caddy. Two things build them:

- [RapidTools](https://github.com/beyond-all-reason/RapidTools) rebuilds the main game
  repos from their git branches on a timer.
- [rapid-builder](../rapid-builder/) builds a repo when a GitHub Actions workflow asks for
  it through [the action](../action/).

Usage
-----

### Dependencies

Make sure required collections are installed by running:

```sh
ansible-galaxy collection install -r requirements.yml
```

If you pull the repo and there are changes to that file, you need to rerun the command to
make sure you pick up the latest changes.

### Vault

We use [Ansible vault](https://docs.ansible.com/projects/ansible/latest/vault_guide/index.html)
for management of secrets in the playbook. Check out
[the official guide](https://docs.ansible.com/ansible/latest/vault_guide/vault_encrypting_content.html#encrypting-files-with-ansible-vault)
for how to view and edit them.

Running the playbook against production needs the vault password. You have to run Ansible
with the `--ask-vault-pass` flag and provide the password when prompted, or you can store
it in a file (Please put it only in something like
[tmpfs](https://en.wikipedia.org/wiki/Tmpfs)!) and point Ansible at it with the
`--vault-password-file` flag or the `ANSIBLE_VAULT_PASSWORD_FILE` environment variable.

### Running

Check what would change on the production host with:

```sh
ansible-playbook -l prod play.yml --check --diff
```

Then drop the `--check` flag to actually apply the changes.

Local testing
-------------

### Setup

We use Incus for local testing. Make sure you have it installed and initialized following
[the official getting started docs](https://linuxcontainers.org/incus/docs/main/tutorial/first_steps/).

To create a new container and initialize it via cloud-init, run the following command:

```sh
touch .incus-integration-on && \
chmod 0600 test.ssh.key && \
incus launch images:debian/trixie/cloud bar-rapid-test < test.incus.yml && \
incus exec bar-rapid-test -- cloud-init status --wait
```

Then test that it works for ansible:

```sh
ansible dev -m shell -a 'uname -a'
```

The test container serves the repos under the `rapid.local` domain name, so it
needs to resolve to the container. Easiest is to add an entry to `/etc/hosts`, which you
can add/update with:

```sh
ansible ,localhost -b -K -m lineinfile -a "path=/etc/hosts regexp='.*rapid\.local.*' line='$(ansible-inventory --host test | jq -r '.ansible_host') rapid.local'"
```

### Usage

Now you can use the playbook as usual, just make sure you are targeting the `dev`
inventory group or the `test` host:

```sh
ansible-playbook -l dev play.yml --diff
```

You can ssh into it with something like:

```sh
ssh -i test.ssh.key ansible@$(ansible-inventory --host test | jq -r '.ansible_host')
```

Or enter directly into the root container shell with:

```sh
incus exec bar-rapid-test -- /bin/bash
```

To verify that the repos are actually served, build one and fetch it with
[pr-downloader](https://github.com/beyond-all-reason/pr-downloader)
(distributed as part of the Recoil releases). Caddy serves the local domain
with its own internal CA, hence the disabled certificate check:

```sh
incus exec bar-rapid-test -- systemctl start --wait update-rapid-repo@chobby.service
PRD_RAPID_REPO_MASTER=https://rapid.local/repos.gz \
  PRD_RAPID_USE_STREAMER=false \
  PRD_DISABLE_CERT_CHECK=true \
  pr-downloader --filesystem-writepath /tmp/prd --download-game chobby:test
```

#### Rapid builder

In dev the builder runs with Bunny disabled, so it doesn't need credentials and
doesn't upload anything. The token comes from a real GitHub Actions run, so for
testing the service prefer the docker compose setup in
[rapid-builder](../rapid-builder).

#### Monitoring host

To configure sending metrics and logs to a local monitoring host set up with the
[ansible-monitoring](https://github.com/beyond-all-reason/ansible-monitoring) playbook,
run:

```sh
MON_HOST_IP=$(incus list -f csv -c 4 bar-mon-test | grep -E 'eth|enp' | cut -d' ' -f1)
ansible-playbook -l dev play.yml --diff -t monitoring \
  -e "{ configure_monitoring: true, monitoring_write_host_ip: $MON_HOST_IP }"
```

The builder's logs arrive in VictoriaLogs as the `rapid-build` stream. To query it on the
monitoring host directly:

```sh
incus exec bar-mon-test -- curl -sG http://victorialogs.dns.podman:9428/select/logsql/query \
  --data-urlencode 'query=stream:rapid-build | sort by (_time) desc' --data-urlencode 'limit=5'
```

### Cleanup

To stop and remove the container:

```sh
incus stop bar-rapid-test && incus delete bar-rapid-test
```
