'use strict';

const config = require('wild-config');
const Joi = require('../joi');
const MongoPaging = require('mongo-cursor-pagination-node6');
const ObjectID = require('mongodb').ObjectID;
const tools = require('../tools');
const consts = require('../consts');

module.exports = (db, server) => {
    /**
     * @api {get} /addresses List registered Addresses
     * @apiName GetAddresses
     * @apiGroup Addresses
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} [query] Partial match of an address
     * @apiParam {Number} [limit=20] How many records to return
     * @apiParam {Number} [page=1] Current page number. Informational only, page numbers start from 1
     * @apiParam {Number} [next] Cursor value for next page, retrieved from <code>nextCursor</code> response value
     * @apiParam {Number} [previous] Cursor value for previous page, retrieved from <code>previousCursor</code> response value
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {Number} total How many results were found
     * @apiSuccess {Number} page Current page number. Derived from <code>page</code> query argument
     * @apiSuccess {String} previousCursor Either a cursor string or false if there are not any previous results
     * @apiSuccess {String} nextCursor Either a cursor string or false if there are not any next results
     * @apiSuccess {Object[]} results Address listing
     * @apiSuccess {String} results.id ID of the Address
     * @apiSuccess {String} results.address E-mail address string
     * @apiSuccess {String} results.user User ID this address belongs to if this is an User address
     * @apiSuccess {Boolean} results.forwarded If true then it is a forwarded address
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/addresses
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "total": 1,
     *       "page": 1,
     *       "previousCursor": false,
     *       "nextCursor": false,
     *       "results": [
     *         {
     *           "id": "59ef21aef255ed1d9d790e81",
     *           "address": "user@example.com",
     *           "user": "59ef21aef255ed1d9d790e7a"
     *         },
     *         {
     *           "id": "59ef21aef255ed1d9d790e81",
     *           "address": "user@example.com",
     *           "forwarded": true
     *         }
     *       ]
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "Database error"
     *     }
     */
    server.get({ name: 'addresses', path: '/addresses' }, (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            query: Joi.string()
                .trim()
                .empty('')
                .max(255),
            limit: Joi.number()
                .default(20)
                .min(1)
                .max(250),
            next: Joi.string()
                .empty('')
                .mongoCursor()
                .max(1024),
            previous: Joi.string()
                .empty('')
                .mongoCursor()
                .max(1024),
            page: Joi.number().default(1)
        });

        const result = Joi.validate(req.query, schema, {
            abortEarly: false,
            convert: true,
            allowUnknown: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let query = result.value.query;
        let limit = result.value.limit;
        let page = result.value.page;
        let pageNext = result.value.next;
        let pagePrevious = result.value.previous;

        let filter =
            (query && {
                address: {
                    // cannot use dotless version as this would break domain search
                    $regex: query.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'),
                    $options: ''
                }
            }) ||
            {};

        db.users.collection('addresses').count(filter, (err, total) => {
            if (err) {
                res.json({
                    error: err.message
                });
                return next();
            }

            let opts = {
                limit,
                query: filter,
                fields: {
                    _id: true,
                    address: true,
                    user: true,
                    targets: true
                },
                paginatedField: 'addrview',
                sortAscending: true
            };

            if (pageNext) {
                opts.next = pageNext;
            } else if (pagePrevious) {
                opts.previous = pagePrevious;
            }

            MongoPaging.find(db.users.collection('addresses'), opts, (err, result) => {
                if (err) {
                    res.json({
                        error: err.message
                    });
                    return next();
                }

                if (!result.hasPrevious) {
                    page = 1;
                }

                let response = {
                    success: true,
                    query,
                    total,
                    page,
                    previousCursor: result.hasPrevious ? result.previous : false,
                    nextCursor: result.hasNext ? result.next : false,
                    results: (result.results || []).map(addressData => ({
                        id: addressData._id.toString(),
                        address: addressData.address,
                        user: addressData.user,
                        forwarded: addressData.targets && true
                    }))
                };

                res.json(response);
                return next();
            });
        });
    });

    /**
     * @api {post} /users/:user/addresses Create new Address
     * @apiName PostUserAddress
     * @apiGroup Addresses
     * @apiDescription Add a new email address for an User. Addresses can contain unicode characters.
     * Dots in usernames are normalized so no need to create both "firstlast@example.com" and "first.last@example.com"
     *
     * Special addresses <code>\*@example.com</code> and <code>username@\*</code> catches all emails to these domains or users without a registered destination (requires <code>allowWildcard</code> argument)
     *
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} user ID of the User
     * @apiParam {String} address E-mail Address
     * @apiParam {Boolean} [main=false] Indicates if this is the default address for the User
     * @apiParam {Boolean} [allowWildcard=false] If <code>true</code> then address value can be in the form of <code>*@example.com</code>, otherwise using * is not allowed
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID of the Address
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPOST http://localhost:8080/users/59fc66a03e54454869460e45/addresses \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "address": "my.new.address@example.com"
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e81"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.post('/users/:user/addresses', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            user: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required(),
            address: [
                Joi.string()
                    .email()
                    .required(),
                Joi.string().regex(/^\w+@\*$/, 'special address')
            ],
            main: Joi.boolean().truthy(['Y', 'true', 'yes', 1]),
            allowWildcard: Joi.boolean().truthy(['Y', 'true', 'yes', 1])
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let user = new ObjectID(result.value.user);
        let main = result.value.main;
        let address = tools.normalizeAddress(result.value.address);

        if (address.indexOf('+') >= 0) {
            res.json({
                error: 'Address can not contain +'
            });
            return next();
        }

        let wcpos = address.indexOf('*');

        if (wcpos >= 0) {
            if (!result.value.allowWildcard) {
                res.json({
                    error: 'Address can not contain *'
                });
                return next();
            }

            if (/[^@]\*|\*[^@]/.test(result.value) || wcpos !== address.lastIndexOf('*')) {
                res.json({
                    error: 'Invalid wildcard address, use "*@domain" or "user@*"'
                });
                return next();
            }

            if (main) {
                res.json({
                    error: 'Main address can not contain *'
                });
                return next();
            }
        }

        db.users.collection('users').findOne(
            {
                _id: user
            },
            {
                fields: {
                    address: true
                }
            },
            (err, userData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }
                if (!userData) {
                    res.json({
                        error: 'This user does not exist',
                        code: 'UserNotFound'
                    });
                    return next();
                }

                db.users.collection('addresses').findOne(
                    {
                        addrview: address.substr(0, address.indexOf('@')).replace(/\./g, '') + address.substr(address.indexOf('@'))
                    },
                    (err, addressData) => {
                        if (err) {
                            res.json({
                                error: 'MongoDB Error: ' + err.message,
                                code: 'InternalDatabaseError'
                            });
                            return next();
                        }

                        if (addressData) {
                            res.json({
                                error: 'This email address already exists',
                                code: 'AddressExists'
                            });
                            return next();
                        }

                        // insert alias address to email address registry
                        db.users.collection('addresses').insertOne(
                            {
                                user,
                                address,
                                addrview: address.substr(0, address.indexOf('@')).replace(/\./g, '') + address.substr(address.indexOf('@')),
                                created: new Date()
                            },
                            (err, r) => {
                                if (err) {
                                    res.json({
                                        error: 'MongoDB Error: ' + err.message,
                                        code: 'InternalDatabaseError'
                                    });
                                    return next();
                                }

                                let insertId = r.insertedId;

                                let done = () => {
                                    // ignore potential user update error
                                    res.json({
                                        success: !!insertId,
                                        id: insertId
                                    });
                                    return next();
                                };

                                if (!userData.address || main) {
                                    // register this address as the default address for that user
                                    return db.users.collection('users').findOneAndUpdate(
                                        {
                                            _id: user
                                        },
                                        {
                                            $set: {
                                                address
                                            }
                                        },
                                        {},
                                        done
                                    );
                                }

                                done();
                            }
                        );
                    }
                );
            }
        );
    });

    /**
     * @api {get} /users/:user/addresses List registered Addresses for an User
     * @apiName GetUserAddresses
     * @apiGroup Addresses
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} user ID of the User
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {Object[]} results Address listing
     * @apiSuccess {String} results.id ID of the Address
     * @apiSuccess {String} results.address E-mail address string
     * @apiSuccess {Boolean} results.main Indicates if this is the default address for the User
     * @apiSuccess {String} results.created Datestring of the time the address was created
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/users/59ef21aef255ed1d9d790e7a/addresses
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "total": 1,
     *       "page": 1,
     *       "previousCursor": false,
     *       "nextCursor": false,
     *       "results": [
     *         {
     *           "id": "59ef21aef255ed1d9d790e81",
     *           "address": "user@example.com",
     *           "main": true,
     *           "created": "2017-10-24T11:19:10.911Z"
     *         }
     *       ]
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.get('/users/:user/addresses', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            user: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required()
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let user = new ObjectID(result.value.user);

        db.users.collection('users').findOne(
            {
                _id: user
            },
            {
                fields: {
                    address: true
                }
            },
            (err, userData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }
                if (!userData) {
                    res.json({
                        error: 'This user does not exist',
                        code: 'UserNotFound'
                    });
                    return next();
                }

                db.users
                    .collection('addresses')
                    .find({
                        user
                    })
                    .sort({
                        addrview: 1
                    })
                    .toArray((err, addresses) => {
                        if (err) {
                            res.json({
                                error: 'MongoDB Error: ' + err.message,
                                code: 'InternalDatabaseError'
                            });
                            return next();
                        }

                        if (!addresses) {
                            addresses = [];
                        }

                        res.json({
                            success: true,

                            results: addresses.map(address => ({
                                id: address._id,
                                address: address.address,
                                main: address.address === userData.address,
                                created: address.created
                            }))
                        });

                        return next();
                    });
            }
        );
    });

    /**
     * @api {get} /users/:user/addresses/:address Request Addresses information
     * @apiName GetUserAddress
     * @apiGroup Addresses
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} user ID of the User
     * @apiParam {String} address ID of the Address
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID of the Address
     * @apiSuccess {String} address E-mail address string
     * @apiSuccess {Boolean} main Indicates if this is the default address for the User
     * @apiSuccess {String} created Datestring of the time the address was created
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/users/59ef21aef255ed1d9d790e7a/addresses/59ef21aef255ed1d9d790e81
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e81",
     *       "address": "user@example.com",
     *       "main": true,
     *       "created": "2017-10-24T11:19:10.911Z"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.get('/users/:user/addresses/:address', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            user: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required(),
            address: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required()
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let user = new ObjectID(result.value.user);
        let address = new ObjectID(result.value.address);

        db.users.collection('users').findOne(
            {
                _id: user
            },
            {
                fields: {
                    address: true
                }
            },
            (err, userData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }
                if (!userData) {
                    res.json({
                        error: 'This user does not exist',
                        code: 'UserNotFound'
                    });
                    return next();
                }

                db.users.collection('addresses').findOne(
                    {
                        _id: address,
                        user
                    },
                    (err, addressData) => {
                        if (err) {
                            res.json({
                                error: 'MongoDB Error: ' + err.message,
                                code: 'InternalDatabaseError'
                            });
                            return next();
                        }
                        if (!addressData) {
                            res.status(404);
                            res.json({
                                error: 'Invalid or unknown address',
                                code: 'AddressNotFound'
                            });
                            return next();
                        }

                        res.json({
                            success: true,
                            id: addressData._id,
                            address: addressData.address,
                            main: addressData.address === userData.address,
                            created: addressData.created
                        });

                        return next();
                    }
                );
            }
        );
    });

    /**
     * @api {put} /users/:user/addresses/:address Update Address information
     * @apiName PutUserAddress
     * @apiGroup Addresses
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} user ID of the User
     * @apiParam {String} address ID of the Address
     * @apiParam {Boolean} main Indicates if this is the default address for the User
     *
     * @apiSuccess {Boolean} success Indicates successful response
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPUT http://localhost:8080/users/59fc66a03e54454869460e45/addresses/5a1d4541153888cdcd62a71b \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "main": true
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.put('/users/:user/addresses/:address', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            user: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required(),
            address: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required(),
            main: Joi.boolean()
                .truthy(['Y', 'true', 'yes', 1])
                .required()
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let user = new ObjectID(result.value.user);
        let address = new ObjectID(result.value.address);
        let main = result.value.main;

        if (!main) {
            res.json({
                error: 'Cannot unset main status'
            });
            return next();
        }

        db.users.collection('users').findOne(
            {
                _id: user
            },
            {
                fields: {
                    address: true
                }
            },
            (err, userData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }
                if (!userData) {
                    res.json({
                        error: 'This user does not exist',
                        code: 'UserNotFound'
                    });
                    return next();
                }

                db.users.collection('addresses').findOne(
                    {
                        _id: address
                    },
                    (err, addressData) => {
                        if (err) {
                            res.json({
                                error: 'MongoDB Error: ' + err.message,
                                code: 'InternalDatabaseError'
                            });
                            return next();
                        }

                        if (!addressData || !addressData.user || addressData.user.toString() !== user.toString()) {
                            res.status(404);
                            res.json({
                                error: 'Invalid or unknown email address identifier',
                                code: 'AddressNotFound'
                            });
                            return next();
                        }

                        if (addressData.address === userData.address) {
                            res.json({
                                error: 'Selected address is already the main email address for the user'
                            });
                            return next();
                        }

                        if (addressData.address.indexOf('*') >= 0 && main) {
                            res.json({
                                error: 'Can not set wildcard address as default'
                            });
                            return next();
                        }

                        // insert alias address to email address registry
                        db.users.collection('users').findOneAndUpdate(
                            {
                                _id: user
                            },
                            {
                                $set: {
                                    address: addressData.address
                                }
                            },
                            {
                                returnOriginal: false
                            },
                            (err, r) => {
                                if (err) {
                                    res.json({
                                        error: 'MongoDB Error: ' + err.message,
                                        code: 'InternalDatabaseError'
                                    });
                                    return next();
                                }

                                res.json({
                                    success: !!r.value
                                });
                                return next();
                            }
                        );
                    }
                );
            }
        );
    });

    /**
     * @api {delete} /users/:user/addresses/:address Delete an Address
     * @apiName DeleteUserAddress
     * @apiGroup Addresses
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} user ID of the User
     * @apiParam {String} address ID of the Address
     *
     * @apiSuccess {Boolean} success Indicates successful response
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XDELETE http://localhost:8080/users/59ef21aef255ed1d9d790e7a/addresses/59ef21aef255ed1d9d790e81
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "Trying to delete main address. Set a new main address first"
     *     }
     */
    server.del('/users/:user/addresses/:address', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            user: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required(),
            address: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required()
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let user = new ObjectID(result.value.user);
        let address = new ObjectID(result.value.address);

        db.users.collection('users').findOne(
            {
                _id: user
            },
            {
                fields: {
                    address: true
                }
            },
            (err, userData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }
                if (!userData) {
                    res.json({
                        error: 'This user does not exist',
                        code: 'UserNotFound'
                    });
                    return next();
                }

                db.users.collection('addresses').findOne(
                    {
                        _id: address
                    },
                    (err, addressData) => {
                        if (err) {
                            res.json({
                                error: 'MongoDB Error: ' + err.message,
                                code: 'InternalDatabaseError'
                            });
                            return next();
                        }

                        if (!addressData || addressData.user.toString() !== user.toString()) {
                            res.status(404);
                            res.json({
                                error: 'Invalid or unknown email address identifier',
                                code: 'AddressNotFound'
                            });
                            return next();
                        }

                        if (addressData.address === userData.address) {
                            res.json({
                                error: 'Trying to delete main address. Set a new main address first'
                            });
                            return next();
                        }

                        // delete address from email address registry
                        db.users.collection('addresses').deleteOne(
                            {
                                _id: address
                            },
                            (err, r) => {
                                if (err) {
                                    res.json({
                                        error: 'MongoDB Error: ' + err.message,
                                        code: 'InternalDatabaseError'
                                    });
                                    return next();
                                }

                                res.json({
                                    success: !!r.deletedCount
                                });
                                return next();
                            }
                        );
                    }
                );
            }
        );
    });

    /**
     * @api {post} /addresses/forwarded Create new forwarded Address
     * @apiName PostForwardedAddress
     * @apiGroup Addresses
     * @apiDescription Add a new forwarded email address. Addresses can contain unicode characters.
     * Dots in usernames are normalized so no need to create both "firstlast@example.com" and "first.last@example.com"
     *
     * Special addresses <code>\*@example.com</code> and <code>username@\*</code> catches all emails to these domains or users without a registered destination (requires <code>allowWildcard</code> argument)
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} address E-mail Address
     * @apiParam {String[]} targets An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25")
     * @apiParam {Number} [forwards] Daily allowed forwarding count for this address
     * @apiParam {Boolean} [allowWildcard=false] If <code>true</code> then address value can be in the form of <code>*@example.com</code>, otherwise using * is not allowed
     * @apiParam {Object} [autoreply] Autoreply information
     * @apiParam {Boolean} [autoreply.enabled] If true, then autoreply is enabled for this address
     * @apiParam {String} [autoreply.start] Either a date string or boolean false to disable start time checks
     * @apiParam {String} [autoreply.end] Either a date string or boolean false to disable end time checks
     * @apiParam {String} [autoreply.subject] Autoreply subject line
     * @apiParam {String} [autoreply.text] Autoreply plaintext content
     * @apiParam {String} [autoreply.html] Autoreply HTML content
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID of the Address
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPOST http://localhost:8080/addresses/forwarded \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "address": "my.new.address@example.com",
     *       "targets": [
     *           "my.old.address@example.com",
     *           "smtp://mx2.zone.eu:25"
     *       ],
     *       "forwards": 500
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e81"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This email address already exists"
     *     }
     */
    server.post('/addresses/forwarded', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            address: [
                Joi.string()
                    .email()
                    .required(),
                Joi.string().regex(/^\w+@\*$/, 'special address')
            ],
            targets: Joi.array()
                .items(
                    Joi.string().email(),
                    Joi.string().uri({
                        scheme: [/smtps?/, /https?/]
                    })
                )
                .min(1),
            forwards: Joi.number()
                .min(0)
                .default(0),
            allowWildcard: Joi.boolean().truthy(['Y', 'true', 'yes', 1]),
            autoreply: Joi.object().keys({
                enabled: Joi.boolean()
                    .truthy(['Y', 'true', 'yes', 1])
                    .default(true),
                start: Joi.date()
                    .empty('')
                    .allow(false),
                end: Joi.date()
                    .empty('')
                    .allow(false),
                subject: Joi.string()
                    .empty('')
                    .trim()
                    .max(128),
                text: Joi.string()
                    .empty('')
                    .trim()
                    .max(128 * 1024),
                html: Joi.string()
                    .empty('')
                    .trim()
                    .max(128 * 1024)
            })
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let address = tools.normalizeAddress(result.value.address);
        let addrview = address.substr(0, address.indexOf('@')).replace(/\./g, '') + address.substr(address.indexOf('@'));

        let targets = result.value.targets;
        let forwards = result.value.forwards;

        if (result.value.autoreply) {
            if (!result.value.autoreply.subject && 'subject' in req.params.autoreply) {
                result.value.autoreply.subject = '';
            }

            if (!result.value.autoreply.text && 'text' in req.params.autoreply) {
                result.value.autoreply.text = '';
                if (!result.value.autoreply.html) {
                    // make sure we also update html part
                    result.value.autoreply.html = '';
                }
            }

            if (!result.value.autoreply.html && 'html' in req.params.autoreply) {
                result.value.autoreply.html = '';
                if (!result.value.autoreply.text) {
                    // make sure we also update plaintext part
                    result.value.autoreply.text = '';
                }
            }
        } else {
            result.value.autoreply = {
                enabled: false
            };
        }

        // needed to resolve users for addresses
        let addrlist = [];
        let cachedAddrviews = new WeakMap();

        for (let i = 0, len = targets.length; i < len; i++) {
            let target = targets[i];
            if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                // email
                let addr = tools.normalizeAddress(target);
                let addrv = addr.substr(0, addr.indexOf('@')).replace(/\./g, '') + addr.substr(addr.indexOf('@'));
                if (addrv === addrview) {
                    res.json({
                        error: 'Can not forward to self "' + target + '"',
                        code: 'InputValidationError'
                    });
                    return next();
                }
                targets[i] = {
                    id: new ObjectID(),
                    type: 'mail',
                    value: target
                };
                cachedAddrviews.set(targets[i], addrv);
                addrlist.push(addrv);
            } else if (/^smtps?:/i.test(target)) {
                targets[i] = {
                    id: new ObjectID(),
                    type: 'relay',
                    value: target
                };
            } else if (/^https?:/i.test(target)) {
                targets[i] = {
                    id: new ObjectID(),
                    type: 'http',
                    value: target
                };
            } else {
                res.json({
                    error: 'Unknown target type "' + target + '"',
                    code: 'InputValidationError'
                });
                return next();
            }
        }

        if (address.indexOf('+') >= 0) {
            res.json({
                error: 'Address can not contain +'
            });
            return next();
        }

        let wcpos = address.indexOf('*');

        if (wcpos >= 0) {
            if (!result.value.allowWildcard) {
                res.json({
                    error: 'Address can not contain *'
                });
                return next();
            }

            if (/[^@]\*|\*[^@]/.test(result.value) || wcpos !== address.lastIndexOf('*')) {
                res.json({
                    error: 'Invalid wildcard address, use "*@domain" or "user@*"'
                });
                return next();
            }
        }

        let resolveUsers = done => {
            if (!addrlist.length) {
                return done();
            }
            db.users
                .collection('addresses')
                .find({
                    addrview: { $in: addrlist }
                })
                .toArray((err, addressList) => {
                    if (err) {
                        res.json({
                            error: 'MongoDB Error: ' + err.message,
                            code: 'InternalDatabaseError'
                        });
                        return next();
                    }
                    let map = new Map(addressList.filter(addr => addr.user).map(addr => [addr.addrview, addr.user]));
                    targets.forEach(target => {
                        let addrv = cachedAddrviews.get(target);
                        if (addrv && map.has(addrv)) {
                            target.user = map.get(addrv);
                        }
                    });
                    done();
                });
        };

        db.users.collection('addresses').findOne(
            {
                addrview
            },
            (err, addressData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }

                if (addressData) {
                    res.json({
                        error: 'This email address already exists',
                        code: 'AddressExists'
                    });
                    return next();
                }

                resolveUsers(() => {
                    // insert alias address to email address registry
                    db.users.collection('addresses').insertOne(
                        {
                            address,
                            addrview: address.substr(0, address.indexOf('@')).replace(/\./g, '') + address.substr(address.indexOf('@')),
                            targets,
                            forwards,
                            autoreply: result.value.autoreply,
                            created: new Date()
                        },
                        (err, r) => {
                            if (err) {
                                res.json({
                                    error: 'MongoDB Error: ' + err.message,
                                    code: 'InternalDatabaseError'
                                });
                                return next();
                            }

                            let insertId = r.insertedId;

                            res.json({
                                success: !!insertId,
                                id: insertId
                            });
                            return next();
                        }
                    );
                });
            }
        );
    });

    /**
     * @api {put} /addresses/forwarded/:address Update forwarded Address information
     * @apiName PutForwardedAddress
     * @apiGroup Addresses
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} address ID of the Address
     * @apiParam {String[]} [targets] An array of forwarding targets. The value could either be an email address or a relay url to next MX server ("smtp://mx2.zone.eu:25"). If set then overwrites previous targets array
     * @apiParam {Number} [forwards] Daily allowed forwarding count for this address
     * @apiParam {Object} [autoreply] Autoreply information
     * @apiParam {Boolean} [autoreply.enabled] If true, then autoreply is enabled for this address
     * @apiParam {String} [autoreply.start] Either a date string or boolean false to disable start time checks
     * @apiParam {String} [autoreply.end] Either a date string or boolean false to disable end time checks
     * @apiParam {String} [autoreply.subject] Autoreply subject line
     * @apiParam {String} [autoreply.text] Autoreply plaintext content
     * @apiParam {String} [autoreply.html] Autoreply HTML content
     *
     * @apiSuccess {Boolean} success Indicates successful response
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPUT http://localhost:8080/addresses/forwarded/5a1d4541153888cdcd62a71b \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "targets": [
     *         "some.other.address@example.com"
     *       ]
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This address does not exist"
     *     }
     */
    server.put('/addresses/forwarded/:address', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            address: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required(),
            targets: Joi.array()
                .items(
                    Joi.string().email(),
                    Joi.string().uri({
                        scheme: [/smtps?/, /https?/]
                    })
                )
                .min(1),
            forwards: Joi.number().min(0),
            autoreply: Joi.object().keys({
                enabled: Joi.boolean().truthy(['Y', 'true', 'yes', 1]),
                start: Joi.date()
                    .empty('')
                    .allow(false),
                end: Joi.date()
                    .empty('')
                    .allow(false),
                subject: Joi.string()
                    .empty('')
                    .trim()
                    .max(128),
                text: Joi.string()
                    .empty('')
                    .trim()
                    .max(128 * 1024),
                html: Joi.string()
                    .empty('')
                    .trim()
                    .max(128 * 1024)
            })
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let address = new ObjectID(result.value.address);
        let updates = {};

        if (result.value.forwards) {
            updates.forwards = result.value.forwards;
        }

        if (result.value.autoreply) {
            if (!result.value.autoreply.subject && 'subject' in req.params.autoreply) {
                result.value.autoreply.subject = '';
            }

            if (!result.value.autoreply.text && 'text' in req.params.autoreply) {
                result.value.autoreply.text = '';
                if (!result.value.autoreply.html) {
                    // make sure we also update html part
                    result.value.autoreply.html = '';
                }
            }

            if (!result.value.autoreply.html && 'html' in req.params.autoreply) {
                result.value.autoreply.html = '';
                if (!result.value.autoreply.text) {
                    // make sure we also update plaintext part
                    result.value.autoreply.text = '';
                }
            }

            Object.keys(result.value.autoreply).forEach(key => {
                updates['autoreply.' + key] = result.value.autoreply[key];
            });
        }

        db.users.collection('addresses').findOne(
            {
                _id: address
            },
            (err, addressData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }

                if (!addressData || !addressData.targets || addressData.user) {
                    res.status(404);
                    res.json({
                        error: 'Invalid or unknown email address identifier',
                        code: 'AddressNotFound'
                    });
                    return next();
                }

                let targets = result.value.targets;
                let addrlist = [];
                let cachedAddrviews = new WeakMap();

                if (targets) {
                    // needed to resolve users for addresses

                    for (let i = 0, len = targets.length; i < len; i++) {
                        let target = targets[i];
                        if (!/^smtps?:/i.test(target) && !/^https?:/i.test(target) && target.indexOf('@') >= 0) {
                            // email
                            let addr = tools.normalizeAddress(target);
                            let addrv = addr.substr(0, addr.indexOf('@')).replace(/\./g, '') + addr.substr(addr.indexOf('@'));
                            if (addrv === addressData.addrview) {
                                res.json({
                                    error: 'Can not forward to self "' + target + '"',
                                    code: 'InputValidationError'
                                });
                                return next();
                            }
                            targets[i] = {
                                id: new ObjectID(),
                                type: 'mail',
                                value: target
                            };
                            cachedAddrviews.set(targets[i], addrv);
                            addrlist.push(addrv);
                        } else if (/^smtps?:/i.test(target)) {
                            targets[i] = {
                                id: new ObjectID(),
                                type: 'relay',
                                value: target
                            };
                        } else if (/^https?:/i.test(target)) {
                            targets[i] = {
                                id: new ObjectID(),
                                type: 'http',
                                value: target
                            };
                        } else {
                            res.json({
                                error: 'Unknown target type "' + target + '"',
                                code: 'InputValidationError'
                            });
                            return next();
                        }
                    }
                }

                let resolveUsers = done => {
                    if (!targets || !addrlist.length) {
                        return done();
                    }
                    db.users
                        .collection('addresses')
                        .find({
                            addrview: { $in: addrlist }
                        })
                        .toArray((err, addressList) => {
                            if (err) {
                                res.json({
                                    error: 'MongoDB Error: ' + err.message,
                                    code: 'InternalDatabaseError'
                                });
                                return next();
                            }
                            let map = new Map(addressList.filter(addr => addr.user).map(addr => [addr.addrview, addr.user]));
                            targets.forEach(target => {
                                let addrv = cachedAddrviews.get(target);
                                if (addrv && map.has(addrv)) {
                                    target.user = map.get(addrv);
                                }
                            });
                            done();
                        });
                };

                resolveUsers(() => {
                    if (targets && targets.length) {
                        updates.targets = targets;
                    }
                    // insert alias address to email address registry
                    db.users.collection('addresses').findOneAndUpdate(
                        {
                            _id: addressData._id
                        },
                        {
                            $set: updates
                        },
                        {
                            returnOriginal: false
                        },
                        (err, r) => {
                            if (err) {
                                res.json({
                                    error: 'MongoDB Error: ' + err.message,
                                    code: 'InternalDatabaseError'
                                });
                                return next();
                            }

                            res.json({
                                success: !!r.value
                            });
                            return next();
                        }
                    );
                });
            }
        );
    });

    /**
     * @api {delete} /addresses/forwarded/:address Delete a forwarded Address
     * @apiName DeleteForwardedAddress
     * @apiGroup Addresses
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} address ID of the Address
     *
     * @apiSuccess {Boolean} success Indicates successful response
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XDELETE http://localhost:8080/addresses/forwarded/59ef21aef255ed1d9d790e81
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This address does not exist"
     *     }
     */
    server.del('/addresses/forwarded/:address', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            address: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required()
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let address = new ObjectID(result.value.address);

        db.users.collection('addresses').findOne(
            {
                _id: address
            },
            (err, addressData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }

                if (!addressData || !addressData.targets || addressData.user) {
                    res.status(404);
                    res.json({
                        error: 'Invalid or unknown email address identifier',
                        code: 'AddressNotFound'
                    });
                    return next();
                }

                // delete address from email address registry
                db.users.collection('addresses').deleteOne(
                    {
                        _id: address
                    },
                    (err, r) => {
                        if (err) {
                            res.json({
                                error: 'MongoDB Error: ' + err.message,
                                code: 'InternalDatabaseError'
                            });
                            return next();
                        }

                        res.json({
                            success: !!r.deletedCount
                        });
                        return next();
                    }
                );
            }
        );
    });

    /**
     * @api {get} /addresses/forwarded/:address Request forwarded Addresses information
     * @apiName GetForwardedAddress
     * @apiGroup Addresses
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} address ID of the Address
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID of the Address
     * @apiSuccess {String} address E-mail address string
     * @apiSuccess {String[]} targets List of forwarding targets
     * @apiSuccess {Object} limits Account limits and usage
     * @apiSuccess {Object} limits.forwards Forwarding quota
     * @apiSuccess {Number} limits.forwards.allowed How many messages per 24 hour can be forwarded
     * @apiSuccess {Number} limits.forwards.used  How many messages are forwarded during current 24 hour period
     * @apiSuccess {Number} limits.forwards.ttl Time until the end of current 24 hour period
     * @apiSuccess {Object} autoreply Autoreply information
     * @apiSuccess {Boolean} autoreply.enabled If true, then autoreply is enabled for this address
     * @apiSuccess {String} autoreply.subject Autoreply subject line
     * @apiSuccess {String} autoreply.text Autoreply plaintext content
     * @apiSuccess {String} autoreply.html Autoreply HTML content
     * @apiSuccess {String} created Datestring of the time the address was created
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/addresses/forwarded/59ef21aef255ed1d9d790e81
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e81",
     *       "address": "user@example.com",
     *       "targets": [
     *          "my.other.address@example.com"
     *       ],
     *       "limits": {
     *         "forwards": {
     *           "allowed": 2000,
     *           "used": 0,
     *           "ttl": false
     *         }
     *       },
     *       "created": "2017-10-24T11:19:10.911Z"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This address does not exist"
     *     }
     */
    server.get('/addresses/forwarded/:address', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            address: Joi.string()
                .hex()
                .lowercase()
                .length(24)
                .required()
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let address = new ObjectID(result.value.address);

        db.users.collection('addresses').findOne(
            {
                _id: address
            },
            (err, addressData) => {
                if (err) {
                    res.json({
                        error: 'MongoDB Error: ' + err.message,
                        code: 'InternalDatabaseError'
                    });
                    return next();
                }
                if (!addressData || !addressData.targets || addressData.user) {
                    res.status(404);
                    res.json({
                        error: 'Invalid or unknown address',
                        code: 'AddressNotFound'
                    });
                    return next();
                }

                db.redis
                    .multi()
                    // sending counters are stored in Redis
                    .get('wdf:' + addressData._id.toString())
                    .ttl('wdf:' + addressData._id.toString())
                    .exec((err, result) => {
                        if (err) {
                            // ignore
                        }

                        let forwards = Number(addressData.forwards) || config.maxForwards || consts.MAX_FORWARDS;

                        let forwardsSent = Number(result && result[0] && result[0][1]) || 0;
                        let forwardsTtl = Number(result && result[1] && result[1][1]) || 0;

                        res.json({
                            success: true,
                            id: addressData._id,
                            address: addressData.address,
                            targets: addressData.targets && addressData.targets.map(t => t.value),
                            limits: {
                                forwards: {
                                    allowed: forwards,
                                    used: forwardsSent,
                                    ttl: forwardsTtl >= 0 ? forwardsTtl : false
                                }
                            },
                            autoreply: addressData.autoreply || { enabled: false },
                            created: addressData.created
                        });

                        return next();
                    });
            }
        );
    });

    /**
     * @api {get} /addresses/resolve/:address Get Address info
     * @apiName GetAddressInfo
     * @apiGroup Addresses
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} address ID of the Address or e-mail address string
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID of the Address
     * @apiSuccess {String} address E-mail address string
     * @apiSuccess {String} user ID of the user if the address belongs to an User
     * @apiSuccess {String[]} targets List of forwarding targets if this is a Forwarded address
     * @apiSuccess {Object} limits Account limits and usage for Forwarded address
     * @apiSuccess {Object} limits.forwards Forwarding quota
     * @apiSuccess {Number} limits.forwards.allowed How many messages per 24 hour can be forwarded
     * @apiSuccess {Number} limits.forwards.used  How many messages are forwarded during current 24 hour period
     * @apiSuccess {Number} limits.forwards.ttl Time until the end of current 24 hour period
     * @apiSuccess {Object} autoreply Autoreply information
     * @apiSuccess {Boolean} autoreply.enabled If true, then autoreply is enabled for this address
     * @apiSuccess {String} autoreply.subject Autoreply subject line
     * @apiSuccess {String} autoreply.text Autoreply plaintext content
     * @apiSuccess {String} autoreply.html Autoreply HTML content
     * @apiSuccess {String} created Datestring of the time the address was created
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/addresses/resolve/k%C3%A4ru%40j%C3%B5geva.ee
     *
     * @apiSuccessExample {json} User-Address:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e81",
     *       "address": "user@example.com",
     *       "user": "59ef21aef255ed1d9d771bb"
     *       "created": "2017-10-24T11:19:10.911Z"
     *     }
     *
     * @apiSuccessExample {json} Forwarded-Address:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e81",
     *       "address": "user@example.com",
     *       "targets": [
     *          "my.other.address@example.com"
     *       ],
     *       "limits": {
     *         "forwards": {
     *           "allowed": 2000,
     *           "used": 0,
     *           "ttl": false
     *         }
     *       },
     *       "autoreply": {
     *          "enabled": false
     *       },
     *       "created": "2017-10-24T11:19:10.911Z"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This address does not exist"
     *     }
     */
    server.get('/addresses/resolve/:address', (req, res, next) => {
        res.charSet('utf-8');

        const schema = Joi.object().keys({
            address: [
                Joi.string()
                    .hex()
                    .lowercase()
                    .length(24)
                    .required(),
                Joi.string().email()
            ]
        });

        const result = Joi.validate(req.params, schema, {
            abortEarly: false,
            convert: true
        });

        if (result.error) {
            res.json({
                error: result.error.message,
                code: 'InputValidationError'
            });
            return next();
        }

        let query = {};
        if (result.value.address.indexOf('@') >= 0) {
            let address = tools.normalizeAddress(result.value.address);
            query = {
                addrview: address.substr(0, address.indexOf('@')).replace(/\./g, '') + address.substr(address.indexOf('@'))
            };
        } else {
            let address = new ObjectID(result.value.address);
            query = {
                _id: address
            };
        }

        db.users.collection('addresses').findOne(query, (err, addressData) => {
            if (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }
            if (!addressData) {
                res.status(404);
                res.json({
                    error: 'Invalid or unknown address',
                    code: 'AddressNotFound'
                });
                return next();
            }

            if (addressData.user) {
                res.json({
                    success: true,
                    id: addressData._id,
                    address: addressData.address,
                    user: addressData.user,
                    created: addressData.created
                });
                return next();
            }

            db.redis
                .multi()
                // sending counters are stored in Redis
                .get('wdf:' + addressData._id.toString())
                .ttl('wdf:' + addressData._id.toString())
                .exec((err, result) => {
                    if (err) {
                        // ignore
                    }

                    let forwards = Number(addressData.forwards) || config.maxForwards || consts.MAX_FORWARDS;

                    let forwardsSent = Number(result && result[0] && result[0][1]) || 0;
                    let forwardsTtl = Number(result && result[1] && result[1][1]) || 0;

                    res.json({
                        success: true,
                        id: addressData._id,
                        address: addressData.address,
                        targets: addressData.targets && addressData.targets.map(t => t.value),
                        limits: {
                            forwards: {
                                allowed: forwards,
                                used: forwardsSent,
                                ttl: forwardsTtl >= 0 ? forwardsTtl : false
                            }
                        },
                        autoreply: addressData.autoreply || { enabled: false },
                        created: addressData.created
                    });

                    return next();
                });
        });
    });
};
