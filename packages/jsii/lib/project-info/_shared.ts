import * as spec from '@jsii/spec';
import * as fs from 'fs-extra';
import * as log4js from 'log4js';
import * as path from 'path';
import * as semver from 'semver';
import { intersect } from 'semver-intersect';

import type { LoadProjectInfoOptions, ProjectInfo } from '../project-info';
import { parsePerson, parseRepository } from '../utils';

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const spdx: Set<string> = require('spdx-license-list/simple');

const LOG = log4js.getLogger('jsii/package-info');

export default async function loadProjectMetadata(
  projectRoot: string,
  { fixPeerDependencies }: LoadProjectInfoOptions,
): Promise<Omit<ProjectInfo, NonSharedMetadataKeys>> {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  // eslint-disable-next-line @typescript-eslint/no-var-requires,@typescript-eslint/no-require-imports
  const pkg = require(packageJsonPath);

  let bundleDependencies: { [name: string]: string } | undefined;
  for (const name of pkg.bundleDependencies ?? pkg.bundledDependencies ?? []) {
    const version = pkg.dependencies?.[name];
    if (!version) {
      throw new Error(
        `The "package.json" file has "${name}" in "bundleDependencies", but it is not declared in "dependencies"`,
      );
    }

    if (pkg.peerDependencies && name in pkg.peerDependencies) {
      throw new Error(
        `The "package.json" file has "${name}" in "bundleDependencies", and also in "peerDependencies"`,
      );
    }

    bundleDependencies = bundleDependencies ?? {};
    bundleDependencies[name] = _resolveVersion(version, projectRoot).version!;
  }

  let addedPeerDependency = false;
  Object.entries(pkg.dependencies ?? {}).forEach(([name, version]) => {
    if (name in (bundleDependencies ?? {})) {
      return;
    }
    version = _resolveVersion(version as any, projectRoot).version;
    pkg.peerDependencies = pkg.peerDependencies ?? {};
    const peerVersion = _resolveVersion(pkg.peerDependencies[name], projectRoot)
      .version;
    if (peerVersion === version) {
      return;
    }
    if (!fixPeerDependencies) {
      if (peerVersion) {
        throw new Error(
          `The "package.json" file has different version requirements for "${name}" in "dependencies" (${
            version as any
          }) versus "peerDependencies" (${peerVersion})`,
        );
      }
      throw new Error(
        `The "package.json" file has "${name}" in "dependencies", but not in "peerDependencies"`,
      );
    }
    if (peerVersion) {
      LOG.warn(
        `Changing "peerDependency" on "${name}" from "${peerVersion}" to ${
          version as any
        }`,
      );
    } else {
      LOG.warn(
        `Recording missing "peerDependency" on "${name}" at ${version as any}`,
      );
    }
    pkg.peerDependencies[name] = version;
    addedPeerDependency = true;
  });
  // Re-write "package.json" if we fixed up "peerDependencies" and were told to automatically fix.
  // Yes, we should never have addedPeerDependencies if not fixPeerDependency, but I still check again.
  if (addedPeerDependency && fixPeerDependencies) {
    await fs.writeJson(packageJsonPath, pkg, { encoding: 'utf8', spaces: 2 });
  }

  const transitiveAssemblies: { [name: string]: spec.Assembly } = {};
  const dependencies = await _loadDependencies(
    pkg.dependencies,
    projectRoot,
    transitiveAssemblies,
    new Set<string>(Object.keys(bundleDependencies ?? {})),
  );
  const peerDependencies = await _loadDependencies(
    pkg.peerDependencies,
    projectRoot,
    transitiveAssemblies,
  );

  const transitiveDependencies = Object.values(transitiveAssemblies);

  return {
    projectRoot,
    packageJson: pkg,

    name: required(
      pkg.name,
      'The "package.json" file must specify the "name" attribute',
    ),
    version: required(
      pkg.version,
      'The "package.json" file must specify the "version" attribute',
    ),
    deprecated: pkg.deprecated,
    stability: _validateStability(pkg.stability, pkg.deprecated),
    author: _toPerson(
      required(
        pkg.author,
        'The "package.json" file must specify the "author" attribute',
      ),
      'author',
    ),
    repository: _toRepository(
      required(
        pkg.repository,
        'The "package.json" file must specify the "repository" attribute',
      ),
    ),
    license: _validateLicense(pkg.license),
    keywords: pkg.keywords,

    main: required(
      pkg.main,
      'The "package.json" file must specify the "main" attribute',
    ),
    types: required(
      pkg.types,
      'The "package.json" file must specify the "types" attribute',
    ),

    dependencies,
    peerDependencies,
    dependencyClosure: transitiveDependencies,
    bundleDependencies,

    description: pkg.description,
    homepage: pkg.homepage,
    contributors: (pkg.contributors as any[])?.map((contrib, index) =>
      _toPerson(contrib, `contributors[${index}]`, 'contributor'),
    ),

    bin: pkg.bin,
  };
}

export function required<T>(value: T, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

type NonSharedMetadataKeys =
  | 'diagnostics'
  | 'excludeTypescript'
  | 'jsiiVersionFormat'
  | 'managedTsconfig'
  | 'metadata'
  | 'projectReferences'
  | 'targets'
  | 'tsc';

async function _loadDependencies(
  dependencies: { [name: string]: string } | undefined,
  searchPath: string,
  transitiveAssemblies: { [name: string]: spec.Assembly },
  bundled = new Set<string>(),
): Promise<{ [name: string]: string }> {
  if (!dependencies) {
    return {};
  }
  const packageVersions: { [name: string]: string } = {};
  for (const name of Object.keys(dependencies)) {
    if (bundled.has(name)) {
      continue;
    }
    const { version: versionString, localPackage } = _resolveVersion(
      dependencies[name],
      searchPath,
    );
    const version = new semver.Range(versionString!);
    if (!version) {
      throw new Error(
        `Invalid semver expression for ${name}: ${versionString}`,
      );
    }
    const pkg = _tryResolveAssembly(name, localPackage, searchPath);
    LOG.debug(`Resolved dependency ${name} to ${pkg}`);
    // eslint-disable-next-line no-await-in-loop
    const assm = await loadAndValidateAssembly(pkg);
    if (!semver.satisfies(assm.version, version)) {
      throw new Error(
        `Declared dependency on version ${versionString} of ${name}, but version ${assm.version} was found`,
      );
    }
    packageVersions[assm.name] =
      packageVersions[assm.name] != null
        ? intersect(versionString!, packageVersions[assm.name])
        : versionString!;
    transitiveAssemblies[assm.name] = assm;
    const pkgDir = path.dirname(pkg);
    if (assm.dependencies) {
      // eslint-disable-next-line no-await-in-loop
      await _loadDependencies(assm.dependencies, pkgDir, transitiveAssemblies);
    }
  }
  return packageVersions;
}

const ASSEMBLY_CACHE = new Map<string, spec.Assembly>();

/**
 * Load a JSII filename and validate it; cached to avoid redundant loads of the same JSII assembly
 */
async function loadAndValidateAssembly(
  jsiiFileName: string,
): Promise<spec.Assembly> {
  if (!ASSEMBLY_CACHE.has(jsiiFileName)) {
    try {
      ASSEMBLY_CACHE.set(jsiiFileName, await fs.readJson(jsiiFileName));
    } catch (e) {
      throw new Error(`Error loading ${jsiiFileName}: ${e}`);
    }
  }
  return ASSEMBLY_CACHE.get(jsiiFileName)!;
}

function _guessRepositoryType(url: string): string {
  if (url.endsWith('.git')) {
    return 'git';
  }
  const parts = /^([^:]+):\/\//.exec(url);
  if (parts?.[1] !== 'http' && parts?.[1] !== 'https') {
    return parts![1];
  }
  throw new Error(
    `The "package.json" file must specify the "repository.type" attribute (could not guess from ${url})`,
  );
}

function _toPerson(
  value: any,
  field: string,
  defaultRole: string = field,
): spec.Person {
  if (typeof value === 'string') {
    value = parsePerson(value);
  }
  return {
    name: required(
      value.name,
      `The "package.json" file must specify the "${field}.name" attribute`,
    ),
    roles: value.roles ? [...new Set(value.roles as string[])] : [defaultRole],
    email: value.email,
    url: value.url,
    organization: value.organization ? value.organization : undefined,
  };
}

function _toRepository(
  value: any,
): { type: string; url: string; directory?: string } {
  if (typeof value === 'string') {
    value = parseRepository(value);
  }
  return {
    url: required(
      value.url,
      'The "package.json" file must specify the "repository.url" attribute',
    ),
    type: value.type || _guessRepositoryType(value.url),
    directory: value.directory,
  };
}

function _tryResolveAssembly(
  mod: string,
  localPackage: string | undefined,
  searchPath: string,
): string {
  if (localPackage) {
    const result = path.join(localPackage, '.jsii');
    if (!fs.existsSync(result)) {
      throw new Error(`Assembly does not exist: ${result}`);
    }
    return result;
  }
  try {
    const paths = [searchPath, path.join(searchPath, 'node_modules')];
    return require.resolve(path.join(mod, '.jsii'), { paths });
  } catch {
    throw new Error(
      `Unable to locate jsii assembly for "${mod}". If this module is not jsii-enabled, it must also be declared under bundledDependencies.`,
    );
  }
}

function _validateLicense(id: string): string {
  if (id === 'UNLICENSED') {
    return id;
  }
  if (!spdx.has(id)) {
    throw new Error(
      `Invalid license identifier "${id}", see valid license identifiers at https://spdx.org/licenses/`,
    );
  }
  return id;
}

function _validateStability(
  stability: string | undefined,
  deprecated: string | undefined,
): spec.Stability | undefined {
  if (!stability && deprecated) {
    stability = spec.Stability.Deprecated;
  } else if (deprecated && stability !== spec.Stability.Deprecated) {
    throw new Error(
      `Package is deprecated (${deprecated}), but it's stability is ${stability} and not ${spec.Stability.Deprecated}`,
    );
  }
  if (!stability) {
    return undefined;
  }
  if (!Object.values(spec.Stability).includes(stability as any)) {
    throw new Error(
      `Invalid stability "${stability}", it must be one of ${Object.values(
        spec.Stability,
      ).join(', ')}`,
    );
  }
  return stability as spec.Stability;
}

function _resolveVersion(
  dep: string,
  searchPath: string,
): { version: string | undefined; localPackage?: string } {
  const matches = /^file:(.+)$/.exec(dep);
  if (!matches) {
    return { version: dep };
  }
  const localPackage = path.resolve(searchPath, matches[1]);
  return {
    // Rendering as a caret version to maintain uniformity against the "standard".
    // eslint-disable-next-line @typescript-eslint/no-require-imports,@typescript-eslint/no-var-requires
    version: `^${require(path.join(localPackage, 'package.json')).version}`,
    localPackage,
  };
}