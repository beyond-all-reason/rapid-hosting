FROM docker.io/library/debian:trixie
ARG SSH_PUB_KEY

RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y systemd ssh python3 nano vim-tiny less file

RUN mkdir -p /root/.ssh \
 && chmod og-rwx /root/.ssh \
 && echo "$SSH_PUB_KEY" > /root/.ssh/authorized_keys

EXPOSE 22/tcp
EXPOSE 80/tcp
EXPOSE 443/tcp

CMD [ "/sbin/init" ]
