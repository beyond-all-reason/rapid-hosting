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
ansible-playbook -i inventory.yaml --skip-tags letsencrypt,ansible_pull \
  -e ansible_ssh_port=$(podman port testsrv 22 | cut -d: -f2) \
  -e repos_address_override=localhost:$(podman port testsrv 443 | cut -d: -f2) \
  -l testsrv play.yaml
podman exec testsrv systemctl start --wait update-rapid-repo@chobby.service
PRD_RAPID_REPO_MASTER=https://localhost:$(podman port testsrv 443 | cut -d: -f2)/repos.gz \
  PRD_DISABLE_CERT_CHECK=true \
  pr-downloader --filesystem-writepath /tmp/prd --download-game chobby:test
```
