const Joi = require('joi');
const HttpResponseService = require('./services/httpResponseService');
const EmailService = require('./services/emailService');
const AuthService = require('./services/authService');

module.exports = [
    {
        method: 'GET',
        path: '/users/{userId}',
        config: {
            plugins: {
                requiredPermissions: (request) => request.params.userId === request.app.currentUserId ? [] : ['ViewUsers']
            },
            validate: {
                params: {
                    userId: Joi.string().uuid().required()
                }
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;

            const userId = request.params.userId;

            logger.debug(`Fetching user ${userId}`);

            const user = await uow.usersRepository.getUserById(userId);
            user.password = null;
            
            return user;
        }
    },
    {
        method: 'GET',
        path: '/users',
        config: {
            plugins: {
                requiredPermissions: ['ViewUsers']
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;

            logger.debug(`Fetching all users`);

            const users = await uow.usersRepository.getAllUsers();

            users.forEach(x => x.password = null);

            return users;
        }
    },
    {
        method: 'POST',
        path: '/users',
        config: {
            plugins: {
                requiredPermissions: ['ViewUsers', 'CreateUsers']
            },
            validate: {
                payload: {
                    firstName: Joi.string().required(),
                    lastName: Joi.string().required(),
                    password: Joi.string().optional(),
                    confirmPassword: Joi.string().optional(),
                    primaryEmailAddress: Joi.string().required(),
                    organizationIds: Joi.array()
                    .items(
                        Joi.string().guid()
                    ).optional()
                }
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;
            const httpResponseService = new HttpResponseService();
            const emailService = new EmailService();
            const authService = new AuthService();

            logger.debug(`Creating user`);
            const payload = request.payload;

            //validate signup details
            if (payload.password !== payload.confirmPassword) {
                return httpResponseService.badData(h);
            }

            const userModel = {
                firstName: payload.firstName,
                lastName: payload.lastName,
                password: await authService.hashPassword(payload.password),
                primaryEmailAddress: payload.primaryEmailAddress,
                disabled: false,
                deleted: false
            };
            
            await uow.beginTransaction();

            const existingUser = await uow.usersRepository.getUserByEmail(userModel.primaryEmailAddress);
            if (existingUser != null) {
                return httpResponseService.conflict(h);
            }

            const organization = await uow.organizationsRepository.createOrganization(userModel.primaryEmailAddress, true);
            const user = await uow.usersRepository.createUser(userModel, payload.organizationIds.concat(organization.id));
            const userEmail = await uow.userEmailsRepository.createUserEmail(user.id, user.primaryEmailAddress);
            const updatedUser = await uow.usersRepository.editUser({primaryEmailId: userEmail.id}, user.id);

            await uow.commitTransaction();

            //send verification email
            await emailService.sendVerificationEmail(userEmail, uow, request);

            return updatedUser;
        }
    },
    {
        method: 'PUT',
        path: '/users/{userId}/general',
        config: {
            plugins: {
                requiredPermissions: ['ViewUsers', 'UpdateBasicUserInfo']
            },
            validate: {
                params: {
                    userId: Joi.string().guid(),
                },
                payload: {
                    firstName: Joi.string().required(),
                    lastName: Joi.string().required()
                }
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;
            const payload = request.payload;
            const userId = request.params.userId;

            logger.debug(`Editing user: ${userId}`);
            await uow.beginTransaction();

            const userDetail = {
                firstName: payload.firstName,
                lastName: payload.lastName
            };

            const user = await uow.usersRepository.editUser(userDetail, userId);

            await uow.commitTransaction();
            
            return user;
        }
    },
    {
        method: 'POST',
        path: '/users/{userId}/addUserEmails',
        config: {
            plugins: {
                requiredPermissions: ['ViewUsers', 'AddEmail']
            },
            validate: {
                params: {
                    userId: Joi.string().guid(),
                },
                payload: {
                    userEmails: Joi.array().items(
                        Joi.object({
                            email: Joi.string().email(),
                            id: Joi.string().guid().allow(null)
                        })
                    )
                }
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const emailService = new EmailService();
            const logger = request.server.app.logger;
            const payload = request.payload;
            const userId = request.params.userId;
            logger.debug(`Editing user emails: ${userId}`);
            await uow.beginTransaction();

            const newOrReusedUserEmails = await uow.userEmailsRepository.addUserEmails(userId, payload.userEmails);

            await uow.commitTransaction();

            if (newOrReusedUserEmails) {
                const promises = newOrReusedUserEmails.map(async userEmail => {
                    return await emailService.sendVerificationEmail(userEmail, uow, request)
                });

                Promise.all(promises);
            }
            
            return true;
        }
    },
    {
        method: 'POST',
        path: '/users/{userId}/deleteUserEmails',
        config: {
            plugins: {
                requiredPermissions: ['ViewUsers', 'DeleteEmail']
            },
            validate: {
                params: {
                    userId: Joi.string().guid()
                },
                payload: {
                    userEmailIds: Joi.array()
                    .items(
                        Joi.string().guid()
                    ).required()
                }
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;
            const userId = request.params.userId;
            const userEmailIds = request.payload.userEmailIds;
            logger.debug(`Editing user emails: ${userId}`);
            await uow.beginTransaction();

            const user = await uow.usersRepository.getUserById(userId);
            if (userEmailIds.includes(user.primaryEmailId)) {
                return httpResponseService.badData(h);
            }

            await uow.userEmailsRepository.deleteUserEmails(userEmailIds, userId);

            await uow.commitTransaction();
            
            return true;
        }
    },
    {
        method: 'PUT',
        path: '/users/{userId}/setPrimaryUserEmail',
        config: {
            plugins: {
                requiredPermissions: ['ViewUsers', 'SetPrimaryEmail']
            },
            validate: {
                params: {
                    userId: Joi.string().guid()
                },
                payload: {
                    primaryUserEmailId: Joi.string().guid().required()
                }
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;
            const userId = request.params.userId;
            const primaryUserEmailId = request.payload.primaryUserEmailId;
            logger.debug(`Updating primary email for: ${userId}`);
            await uow.beginTransaction();

            const userEmail = await uow.userEmailsRepository.getUserEmailById(primaryUserEmailId);

            await uow.usersRepository.setPrimaryUserEmail(userId, userEmail);

            await uow.commitTransaction();
            
            return true;
        }
    },
    {
        method: 'PUT',
        path: '/users/{userId}/organizations',
        config: {
            plugins: {
                requiredPermissions: ['ViewUsers', 'ManageUserOrganizations']
            },
            validate: {
                params: {
                    userId: Joi.string().guid(),
                },
                payload: {
                    organizationIds: Joi.array()
                    .items(
                        Joi.string().guid()
                    ).optional(),
                }
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;
            const payload = request.payload;
            const userId = request.params.userId;
            logger.debug(`Editing user organizations: ${userId}`);
            await uow.beginTransaction();

            await uow.usersRepository.replaceUserOrganizationsByUserId(userId, payload.organizationIds);

            await uow.commitTransaction();
            
            return h.continue;
        }
    },
    {
        method: 'PUT',
        path: '/users/{userId}/roles',
        config: {
            plugins: {
                requiredPermissions: ['ViewUsers', 'ManageUserRoles']
            },
            validate: {
                params: {
                    userId: Joi.string().guid(),
                },
                payload: {
                    roleIds: Joi.array()
                    .items(
                        Joi.string().guid()
                    ).optional(),
                }
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;
            const payload = request.payload;
            const userId = request.params.userId;
            logger.debug(`Editing user roles for user: ${userId}`);
            await uow.beginTransaction();

            await uow.usersRepository.replaceUserRoles(userId, payload.roleIds);

            await uow.commitTransaction();
            
            return h.continue;
        }
    },
    {
        method: 'GET',
        path: '/users/{userId}/roles',
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;
            const userId = request.params.userId;
            
            logger.debug(`Fetching user roles for user: ${userId}`);

            const userRoles = await uow.usersRepository.getUserRoles(userId);
            
            return userRoles;
        },
        options: {
            validate: {
                params: {
                    userId: Joi.string().guid(),
                }
            }
        }
    },
    {
        method: 'DELETE',
        path: '/users/{userId}',
        config: {
            plugins: {
                requiredPermissions: ['ViewUsers', 'DeleteUsers']
            },
            validate: {
                params: {
                    userId: Joi.string().uuid().required()
                }
            }
        },
        handler: async (request, h) => {
            const uow = await request.app.getNewUoW();
            const logger = request.server.app.logger;
            const userId = request.params.userId;

            logger.debug(`Deleting user with id: ${userId}`);

            const result = await uow.usersRepository.deleteUser(userId);
            
            return result;
        }
    }
];