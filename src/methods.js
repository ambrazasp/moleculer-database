/*
 * @moleculer/database
 * Copyright (c) 2021 MoleculerJS (https://github.com/moleculerjs/database)
 * MIT Licensed
 */

"use strict";

const Adapters = require("./adapters");
const { Context } = require("moleculer"); // eslint-disable-line no-unused-vars
const { EntityNotFoundError } = require("./errors");
const { MoleculerClientError } = require("moleculer").Errors;
const { Transform } = require("stream");
const _ = require("lodash");

module.exports = function (mixinOpts) {
	const cacheOpts = mixinOpts.cache && mixinOpts.cache.enabled ? mixinOpts.cache : null;

	return {
		/**
		 * Get or create an adapter. Multi-tenant support method.
		 * @param {Context?} ctx
		 */
		async getAdapter(ctx) {
			const [hash, adapterOpts] = this.getAdapterByContext(ctx, mixinOpts.adapter);
			const item = this.adapters.get(hash);
			if (item) return item.adapter;

			const adapter = Adapters.resolve(adapterOpts);
			adapter.init(this);
			this.adapters.set(hash, { hash, adapter });
			await this._connect(adapter);

			return adapter;
		},

		/**
		 * For multi-tenant support this method generates a cache key
		 * hash value from `ctx`. By default, it returns "default" hash key.
		 * It can be overwritten to implement custom multi-tenant solution.
		 *
		 * @param {Context?} ctx
		 * @param {Object|any?} adapterDef
		 */
		getAdapterByContext(ctx, adapterDef) {
			return ["default", adapterDef];
		},

		/**
		 * Connect to the DB
		 */
		_connect(adapter) {
			return new this.Promise((resolve, reject) => {
				const connecting = async () => {
					try {
						await adapter.connect();
						resolve();
					} catch (err) {
						this.logger.error("Connection error!", err);
						if (mixinOpts.autoReconnect) {
							setTimeout(() => {
								this.logger.warn("Reconnecting...");
								connecting();
							}, 1000);
						} else {
							reject(err);
						}
					}
				};
				connecting();
			});
		},

		/**
		 * Disconnect an adapter
		 */
		_disconnect(adapter) {
			if (_.isFunction(adapter.disconnect)) return adapter.disconnect();
			return this.Promise.resolve();
		},

		/**
		 * Disconnect all adapters
		 */
		disconnectAll() {
			const adapters = Array.from(this.adapters.values()).map(item => item.adapter);
			this.adapters.clear();

			this.logger.info(`Disconnect ${adapters.length} adapters...`);
			return Promise.all(adapters.map(adapter => this._disconnect(adapter)));
		},

		/**
		 * Apply scopes for the params query.
		 *
		 * @param {Object} params
		 * @param {Context?} ctx
		 */
		_applyScopes(params, ctx) {
			let scopes = null;
			if (params.scope) {
				scopes = Array.isArray(params.scope) ? params.scope : [params.scope];
			} else if (params.scope !== false) {
				scopes = this.settings.defaultScopes;
			}

			if (scopes && scopes.length > 0) {
				params.query = scopes.reduce((query, scopeName) => {
					const scope = this.settings.scopes[scopeName];
					if (!scope) return query;

					if (_.isFunction(scope)) return scope.call(this, query, ctx);
					else return _.defaultsDeep(query, scope);
				}, _.cloneDeep(params.query || {}));
			}

			return params;
		},

		/**
		 * Sanitize incoming parameters for `find`, `list`, `count` actions.
		 *
		 * @param {Object} params
		 * @param {Object?} opts
		 * @returns {Object}
		 */
		sanitizeParams(params, opts) {
			const p = Object.assign({}, params);
			if (typeof p.limit === "string") p.limit = Number(p.limit);
			if (typeof p.offset === "string") p.offset = Number(p.offset);
			if (typeof p.page === "string") p.page = Number(p.page);
			if (typeof p.pageSize === "string") p.pageSize = Number(p.pageSize);

			if (typeof p.query === "string") p.query = JSON.parse(p.query);

			if (typeof p.sort === "string") p.sort = p.sort.replace(/,/g, " ").split(" ");
			if (typeof p.fields === "string") p.fields = p.fields.replace(/,/g, " ").split(" ");
			if (typeof p.populate === "string")
				p.populate = p.populate.replace(/,/g, " ").split(" ");
			if (typeof p.searchFields === "string")
				p.searchFields = p.searchFields.replace(/,/g, " ").split(" ");

			if (opts && opts.removeLimit) {
				if (p.limit) delete p.limit;
				if (p.offset) delete p.offset;
				if (p.page) delete p.page;
				if (p.pageSize) delete p.pageSize;

				return p;
			}

			if (opts && opts.list) {
				// Default `pageSize`
				if (!p.pageSize) p.pageSize = mixinOpts.defaultPageSize;

				// Default `page`
				if (!p.page) p.page = 1;

				// Limit the `pageSize`
				if (mixinOpts.maxLimit > 0 && p.pageSize > mixinOpts.maxLimit)
					p.pageSize = mixinOpts.maxLimit;

				// Calculate the limit & offset from page & pageSize
				p.limit = p.pageSize;
				p.offset = (p.page - 1) * p.pageSize;
			}
			// Limit the `limit`
			if (mixinOpts.maxLimit > 0 && p.limit > mixinOpts.maxLimit)
				p.limit = mixinOpts.maxLimit;

			return p;
		},

		/**
		 * Find all entities by query & limit.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async findEntities(ctx, params = ctx.params, opts = {}) {
			params = this.sanitizeParams(params);
			params = this._applyScopes(params, ctx);

			const adapter = await this.getAdapter(ctx);

			let result = await adapter.find(params);
			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, params, ctx);
			}
			return result;
		},

		/**
		 * Find all entities by query & limit.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 * @returns {Promise<Stream>}
		 */
		async streamEntities(ctx, params = ctx.params, opts = {}) {
			params = this.sanitizeParams(params);
			params = this._applyScopes(params, ctx);

			const adapter = await this.getAdapter(ctx);
			const stream = await adapter.findStream(params);

			if (opts.transform !== false) {
				const self = this;
				const transform = new Transform({
					objectMode: true,
					transform: async function (doc, encoding, done) {
						const res = await self.transformResult(adapter, doc, params, ctx);
						this.push(res);
						return done();
					}
				});
				stream.pipe(transform);
				return transform;
			}

			return stream;
		},

		/**
		 * Count entities by query & limit.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 */
		async countEntities(ctx, params = ctx.params) {
			params = this.sanitizeParams(params, { removeLimit: true });
			params = this._applyScopes(params, ctx);

			const adapter = await this.getAdapter(ctx);
			const result = await adapter.count(params);
			return result;
		},

		/**
		 * Find only one entity by query.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async findEntity(ctx, params = ctx.params, opts = {}) {
			params = this.sanitizeParams(params, { removeLimit: true });
			params = this._applyScopes(params, ctx);
			params.limit = 1;

			const adapter = await this.getAdapter(ctx);
			let result = await adapter.findOne(params.query);
			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, params, ctx);
			}
			return result;
		},

		/**
		 * Get ID value from `params`.
		 *
		 * @param {Object} params
		 */
		_getIDFromParams(params, throwIfNotExist = true) {
			let id = params[this.$primaryField.name];

			if (throwIfNotExist && id == null) {
				throw new MoleculerClientError("Missing id field.", 400, "MISSING_ID", { params });
			}

			return id;
		},

		/**
		 * Resolve entities IDs with mapping.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async resolveEntities(ctx, params = ctx.params, opts = {}) {
			// Get ID value from params
			let id = this._getIDFromParams(params);
			const origID = id;
			const multi = Array.isArray(id);
			if (!multi) id = [id];

			// Decode ID if need
			id = id.map(id => this._sanitizeID(id, opts));

			// Apply scopes & set ID filtering
			params = this._applyScopes(Object.assign({}, params), ctx);
			if (!params.query) params.query = {};

			let idField = this.$primaryField.columnName;

			if (multi) {
				params.query[idField] = { $in: id };
			} else {
				params.query[idField] = id[0];
			}

			const adapter = await this.getAdapter(ctx);

			// Find the entities
			let result = await adapter.find(params);
			if (!result || result.length == 0) {
				if (opts.throwIfNotExist) throw new EntityNotFoundError(origID);
			}

			// For mapping
			const unTransformedRes = Array.from(result);

			// Transforming
			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, params, ctx);
			}

			// Mapping
			if (params.mapping === true) {
				result = result.reduce((map, doc, i) => {
					let id = unTransformedRes[i][idField];
					if (this.$primaryField.secure) id = this.encodeID(id);

					map[id] = doc;
					return map;
				}, {});
			} else if (!multi) {
				result = result[0];
			}

			return result;
		},

		/**
		 * Create an entity.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async createEntity(ctx, params = ctx.params, opts = {}) {
			params = await this.validateParams(ctx, params, { type: "create" });

			const adapter = await this.getAdapter(ctx);
			let result = await adapter.insert(params);
			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, {}, ctx);
			}

			await this._entityChanged(result, ctx, { ...opts, type: "create" });
			return result;
		},

		/**
		 * Insert entities.
		 *
		 * @param {Context} ctx
		 * @param {Array<Object>?} params
		 * @param {Object?} opts
		 */
		async createEntities(ctx, params = ctx.params, opts = {}) {
			const entities = await Promise.all(
				params.map(
					async entity => await this.validateParams(ctx, entity, { type: "create" })
				)
			);

			const adapter = await this.getAdapter(ctx);
			let result = await adapter.insertMany(entities);
			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, {}, ctx);
			}

			await this._entityChanged(result, ctx, { ...opts, type: "create", batch: true });
			return result;
		},

		/**
		 * Update an entity (patch).
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async updateEntity(ctx, params = ctx.params, opts = {}) {
			let id = this._getIDFromParams(params);

			// Call because it throws error if entity is not exist
			const oldEntity = await this.resolveEntities(ctx, params, {
				transform: false,
				throwIfNotExist: true
			});

			const rawUpdate = params.$raw === true;
			if (rawUpdate) delete params.$raw;

			if (!rawUpdate) {
				params = await this.validateParams(ctx, params, { type: "update", oldEntity });
			}

			id = this._sanitizeID(id, opts);

			delete params[this.$primaryField.columnName];
			if (this.$primaryField.columnName != this.$primaryField.name)
				delete params[this.$primaryField.name];

			const adapter = await this.getAdapter(ctx);
			let result = await adapter.updateById(id, params, { raw: rawUpdate });

			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, {}, ctx);
			}

			await this._entityChanged(result, ctx, { ...opts, type: "update" });
			return result;
		},

		/**
		 * Replace an entity.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async replaceEntity(ctx, params = ctx.params, opts = {}) {
			let id = this._getIDFromParams(params);

			// Call because it throws error if entity is not exist
			const oldEntity = await this.resolveEntities(ctx, params, {
				transform: false,
				throwIfNotExist: true
			});
			const adapter = await this.getAdapter(ctx);

			params = await this.validateParams(ctx, params, { type: "replace", oldEntity });

			id = this._sanitizeID(id, opts);

			delete params[this.$primaryField.columnName];
			if (this.$primaryField.columnName != this.$primaryField.name)
				delete params[this.$primaryField.name];

			let result = await adapter.replaceById(id, params);

			if (opts.transform !== false) {
				result = await this.transformResult(adapter, result, {}, ctx);
			}

			await this._entityChanged(result, ctx, { ...opts, type: "replace" });
			return result;
		},

		/**
		 * Delete an entity.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 * @param {Object?} opts
		 */
		async removeEntity(ctx, params = ctx.params, opts = {}) {
			let id = this._getIDFromParams(params);
			const origID = id;

			let entity = await this.resolveEntities(ctx, params, {
				transform: false,
				throwIfNotExist: true
			});

			const adapter = await this.getAdapter(ctx);

			params = await this.validateParams(ctx, params, { type: "remove" });

			id = this._sanitizeID(id, opts);

			if (this.$softDelete) {
				// Soft delete
				await adapter.updateById(id, params);
			} else {
				// Real delete
				await adapter.removeById(id);
			}

			if (opts.transform !== false) {
				entity = await this.transformResult(adapter, entity, params, ctx);
			}

			await this._entityChanged(entity, ctx, {
				...opts,
				type: "remove",
				softDelete: !!this.$softDelete
			});

			return origID;
		},

		/**
		 * Clear all entities.
		 *
		 * @param {Context} ctx
		 * @param {Object?} params
		 */
		async clearEntities(ctx, params) {
			const adapter = await this.getAdapter(ctx);
			const result = await adapter.clear(params);
			return result;
		},

		/**
		 * Create an index.
		 *
		 * @param {Object} def
		 */
		createIndex(adapter, def) {
			return adapter.createIndex(def);
		},

		/**
		 * Called when an entity changed.
		 * @param {any} data
		 * @param {Context?} ctx
		 * @param {Object?} opts
		 */
		async _entityChanged(data, ctx, opts = {}) {
			if (cacheOpts && cacheOpts.eventName) {
				// Cache cleaning event
				(ctx || this.broker).broadcast(cacheOpts.eventName);
			}

			this.entityChanged(opts.type, data, ctx);
		},

		/**
		 * Can be user-defined which is called when an entity changed.
		 * @param {String} type
		 * @param {any} data
		 * @param {Context?} ctx
		 */
		entityChanged(type, data, ctx) {
			// Abstract method
		},

		/**
		 * Encode ID of entity.
		 *
		 * @methods
		 * @param {any} id
		 * @returns {any}
		 */
		encodeID(id) {
			return id;
		},

		/**
		 * Decode ID of entity.
		 *
		 * @methods
		 * @param {any} id
		 * @returns {any}
		 */
		decodeID(id) {
			return id;
		},

		/**
		 * Sanitize the input ID. Decode if it's secured.
		 * @param {any} id
		 * @param {Object?} opts
		 * @returns {any}
		 */
		_sanitizeID(id, opts) {
			if (opts.secureID != null) {
				return opts.secureID ? this.decodeID(id) : id;
			} else if (this.$primaryField.secure) {
				return this.decodeID(id);
			}
			return id;
		}
	};
};