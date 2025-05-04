import asyncHandler from "../middleware/asyncHandler.js"
import User from "../models/userModel.js"
import generateToken from "../utils/generateToken.js"

// @desc    Auth user & get token
// @route   POST /api/users/auth
// @access  Public
const authUser = asyncHandler(async(req,res) => {
    const {email, password} = req.body

    const user = await User.findOne({email})

    if(user && (await user.matchPassword(password))){ // from user model (we compare passwords)
        generateToken(res, user._id)
        
        res.status(200).json({
            _id: user._id,
            name: user.name,
            phoneNumber: user.phoneNumber,
            email: user.email,
            isAdmin: user.isAdmin,
            address: user.address,
        })

    } else {
        res.status(401)
        throw new Error('Invalid Input or Not Registered')
    }
})

// @desc    Register user
// @route   POST /api/users
// @access  Public
const registerUser = asyncHandler(async(req,res) => {
    const { name, phoneNumber, email, password } = req.body;
    const userExists = await User.findOne({ email });

    if (userExists) {
        res.status(400);
        throw new Error('User already exists');
    }

    const user = await User.create({ name, phoneNumber, email, password });

    if (user) {
        generateToken(res, user._id);
        res.status(201).json({
            _id: user._id,
            name: user.name,
            phoneNumber: user.phoneNumber,
            email: user.email,
            isAdmin: user.isAdmin,
        });
    } else {
        res.status(400);
        throw new Error('Invalid user data');
    }
});

// @desc    Logout user / clear cookie
// @route   POST /api/users/logout
// @access  Private
const logoutUser = asyncHandler(async(req,res) => {
    res.cookie('jwt', '', {
        httpOnly: true,
        expires: new Date(0)
    })

    res.status(200).json({message: 'Logged out successfully'})
})

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
const getUserProfile = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
  
    if (user) {
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email, // ✅ Include email
        phoneNumber: user.phoneNumber, // ✅ Ensure phoneNumber is included
        address: user.address, // ✅ Ensure address is included
        isAdmin: user.isAdmin,
        wallet: user.wallet,
        outstandingBalance: user.outstandingBalance,
      });
    } else {
      res.status(404);
      throw new Error("User not found");
    }
  });

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
const updateUserProfile = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
  
    if (user) {
        console.log(req.body.phoneNumber);
        
      user.name = req.body.name || user.name;
      user.phoneNumber = req.body.phoneNumber || user.phoneNumber;
      user.address = req.body.address || user.address;
  
      const updatedUser = await user.save();
  
      res.json({
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email, // Email shouldn't be changed
        phoneNumber: updatedUser.phoneNumber,
        address: updatedUser.address,
        isAdmin: updatedUser.isAdmin,
      });
    } else {
      res.status(404);
      throw new Error("User not found");
    }
  });

// @desc    Get users
// @route   GET /api/users
// @access  Private/Admin
const getUsers = asyncHandler(async(req,res) => {
    const users = await User.find({})
    res.status(200).json(users)
})

// @desc    Get user by ID
// @route   GET /api/users/:id
// @access  Private/Admin
const getUserById = asyncHandler(async(req,res) => {
    const user = await User.findById(req.params.id).select('-password')

    if(user){
        res.status(200).json(user)
    } else {
        res.status(404)
        throw new Error('User not found')
    }
})

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private/Admin
const deleteUser = asyncHandler(async(req,res) => {
    const user = await User.findById(req.params.id)

    if(user){
        if(user.isAdmin){
            res.status(400)
            throw new Error('Cannot delete admin user')
        }
        await User.deleteOne({_id: user._id})
        res.status(200).json({message: 'User deleted successfully'})
    } else {
        res.status(404)
        throw new Error('User not found')
    }
})

// @desc    Update user (Admin)
// @route   PUT /api/users/:id
// @access  Private/Admin
const updateUser = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);

    if (!user) {
        res.status(404);
        throw new Error("User not found");
    }

    // Update user fields from request body (keep existing values if not provided)
    user.name = req.body.name || user.name;
    user.email = req.body.email || user.email;
    user.phoneNumber = req.body.phoneNumber || user.phoneNumber;
    user.address = req.body.address || user.address;
    user.wallet = req.body.wallet !== undefined ? req.body.wallet : user.wallet;
    user.outstandingBalance = req.body.outstandingBalance !== undefined ? req.body.outstandingBalance : user.outstandingBalance;
    user.isAdmin = Boolean(req.body.isAdmin);

    const updatedUser = await user.save();

    res.status(200).json({
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        phoneNumber: updatedUser.phoneNumber,
        address: updatedUser.address,
        wallet: updatedUser.wallet,
        outstandingBalance: updatedUser.outstandingBalance,
        isAdmin: updatedUser.isAdmin,
    });
});

export {
    authUser,
    registerUser,
    logoutUser,
    getUserProfile,
    getUserById,
    updateUser,
    updateUserProfile,
    deleteUser,
    getUsers,
}