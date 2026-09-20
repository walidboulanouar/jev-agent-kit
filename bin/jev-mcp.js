#!/usr/bin/env node
import { createClient } from '../src/client.js';
import { serve } from '../src/mcp.js';
serve(createClient()).then(() => process.exit(0));
