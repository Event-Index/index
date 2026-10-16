# The relay as the server runs it, for relay/test/strfry.test.ts: strfry built
# from source at its pinned release commit, and Node for the write policy.
# The build arguments default to deploy/config.example.env's pins.
#
#   docker build -t eventindex-strfry-test -f relay/test/strfry.Dockerfile relay/test

FROM ubuntu:24.04
ARG STRFRY_VERSION=1.1.3
ARG STRFRY_COMMIT=16c00df04e264f4d68db5e10a48127f015c7824b
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256_X64=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
ARG NODE_SHA256_ARM64=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f
ARG TARGETARCH
# Parallel compile jobs; each can take 1.5 GB or more.
ARG JOBS=2
RUN apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
      ca-certificates curl git xz-utils build-essential pkg-config \
      libssl-dev zlib1g-dev liblmdb-dev libflatbuffers-dev libsecp256k1-dev libzstd-dev \
      libyaml-perl libtemplate-perl libregexp-grammars-perl \
    && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in amd64) a=x64; sha=$NODE_SHA256_X64 ;; arm64) a=arm64; sha=$NODE_SHA256_ARM64 ;; *) exit 1 ;; esac \
    && curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$a.tar.xz" \
    && echo "$sha  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz
RUN git clone https://github.com/hoytech/strfry /usr/local/src/strfry \
    && cd /usr/local/src/strfry && git checkout -q "$STRFRY_VERSION" \
    && [ "$(git rev-parse HEAD)" = "$STRFRY_COMMIT" ] \
    && git submodule update --init -q && make setup-golpe && make -j"$JOBS" \
    && install -m 755 strfry /usr/local/bin/strfry && cd / && rm -rf /usr/local/src/strfry
RUN mkdir -p /var/lib/strfry/db /var/lib/eventindex /opt/eventindex/app
EXPOSE 7777
CMD ["/usr/local/bin/strfry", "--config=/etc/strfry.conf", "relay"]
