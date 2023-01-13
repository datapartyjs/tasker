#!/bin/bash

set -o xtrace

rm -rf docs
npm run generate-docs
mv docs/@dataparty/tasker/0.0.2/* docs/
cp -r images/ docs