FROM ubuntu:22.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    make \
    git \
    libcap-dev \
    libseccomp-dev \
    libsystemd-dev \
    pkg-config \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install isolate
WORKDIR /tmp
RUN git clone https://github.com/ioi/isolate.git && \
    cd isolate && \
    make isolate && \
    make install

# Configure isolate
RUN sed -i 's/^subid_user = isolate/# subid_user = isolate/' /usr/local/etc/isolate && \
    sed -i 's/# first_uid = 60000/first_uid = 60000/' /usr/local/etc/isolate && \
    sed -i 's/# first_gid = 60000/first_gid = 60000/' /usr/local/etc/isolate && \
    sed -i 's/# num_boxes = 1000/num_boxes = 1000/' /usr/local/etc/isolate

WORKDIR /workspace
